import type { BBox, LngLat, Polygon, ProgressFn, Tags } from "../types";
import { assembleRings, buildPolygons, pointInPolygon, ringCentroid } from "../geo/polygon";

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const OVERPASS_TIMEOUT_MS = 60_000;

export interface BuildingFeature {
  id: string;
  tags: Tags;
  polygons: Polygon[];
  isPart: boolean;
}

export interface LineFeature {
  id: string;
  tags: Tags;
  points: LngLat[];
}

export interface AreaFeature {
  id: string;
  tags: Tags;
  /** "forest" = bosque o arbolado; "green" = césped, parques y matorral. */
  kind: "water" | "green" | "forest";
  polygons: Polygon[];
}

export interface OsmData {
  buildings: BuildingFeature[];
  roads: LineFeature[];
  railways: LineFeature[];
  /** Ríos, arroyos y canales dibujados como líneas. */
  waterways: LineFeature[];
  areas: AreaFeature[];
  /** Árboles sueltos mapeados (natural=tree). */
  trees: LngLat[];
}

export function buildOverpassQuery(b: BBox): string {
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:90];
(
  way["building"](${box});
  relation["building"]["type"="multipolygon"](${box});
  way["building:part"](${box});
  relation["building:part"]["type"="multipolygon"](${box});
  way["highway"](${box});
  way["railway"~"^(rail|light_rail|tram|subway|narrow_gauge)$"](${box});
  way["waterway"~"^(river|stream|canal|drain|ditch)$"](${box});
  node["natural"="tree"](${box});
  way["natural"~"^(water|wood|scrub|grassland)$"](${box});
  relation["natural"~"^(water|wood)$"](${box});
  relation["landuse"="forest"](${box});
  way["waterway"="riverbank"](${box});
  way["landuse"~"^(forest|grass|meadow|park|recreation_ground|village_green|cemetery)$"](${box});
  way["leisure"~"^(park|garden|pitch|golf_course)$"](${box});
);
out geom;`;
}

type OverpassGeom = { lat: number; lon: number }[];
interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Tags;
  geometry?: OverpassGeom;
  members?: { type: string; role: string; geometry?: OverpassGeom }[];
}

const toLngLat = (g: OverpassGeom): LngLat[] => g.map((p) => ({ lng: p.lon, lat: p.lat }));

function closedWayPolygon(el: OverpassElement): Polygon[] {
  if (!el.geometry || el.geometry.length < 4) return [];
  const pts = toLngLat(el.geometry);
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a.lng !== b.lng || a.lat !== b.lat) return [];
  return [{ outer: pts, holes: [] }];
}

function relationPolygons(el: OverpassElement): Polygon[] {
  const outers: LngLat[][] = [];
  const inners: LngLat[][] = [];
  for (const m of el.members ?? []) {
    if (m.type !== "way" || !m.geometry) continue;
    (m.role === "inner" ? inners : outers).push(toLngLat(m.geometry));
  }
  return buildPolygons(assembleRings(outers), assembleRings(inners));
}

function areaKind(t: Tags): AreaFeature["kind"] | null {
  if (t.natural === "water" || t.waterway === "riverbank") return "water";
  if (t.natural === "wood" || t.landuse === "forest") return "forest";
  if (t.natural || t.landuse || t.leisure) return "green";
  return null;
}

/** Convierte la respuesta de Overpass en entidades geométricas listas para modelar. */
export function parseOverpass(json: { elements: OverpassElement[] }): OsmData {
  const out: OsmData = { buildings: [], roads: [], railways: [], waterways: [], areas: [], trees: [] };
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const id = `${el.type}/${el.id}`;
    if (el.type === "node") {
      if (tags.natural === "tree" && el.lat !== undefined && el.lon !== undefined) out.trees.push({ lng: el.lon, lat: el.lat });
      continue;
    }
    const isBuilding = !!tags.building || !!tags["building:part"];
    if (isBuilding) {
      const polygons = el.type === "relation" ? relationPolygons(el) : closedWayPolygon(el);
      if (polygons.length) out.buildings.push({ id, tags, polygons, isPart: !!tags["building:part"] && !tags.building });
      continue;
    }
    if (el.type === "way" && tags.highway && el.geometry) {
      if (tags.area === "yes") continue;
      out.roads.push({ id, tags, points: toLngLat(el.geometry) });
      continue;
    }
    if (el.type === "way" && tags.railway && el.geometry) {
      out.railways.push({ id, tags, points: toLngLat(el.geometry) });
      continue;
    }
    if (el.type === "way" && tags.waterway && tags.waterway !== "riverbank" && el.geometry) {
      out.waterways.push({ id, tags, points: toLngLat(el.geometry) });
      continue;
    }
    const kind = areaKind(tags);
    if (kind) {
      const polygons = el.type === "relation" ? relationPolygons(el) : closedWayPolygon(el);
      if (polygons.length) out.areas.push({ id, tags, kind, polygons });
    }
  }
  out.buildings = suppressOutlinesWithParts(out.buildings);
  return out;
}

/**
 * Simple 3D Buildings: cuando un edificio está descrito con `building:part`,
 * el contorno general solo sirve para 2D y no debe extruirse.
 */
export function suppressOutlinesWithParts(buildings: BuildingFeature[]): BuildingFeature[] {
  const parts = buildings.filter((b) => b.isPart);
  if (!parts.length) return buildings;
  const partCentroids = parts.map((p) => ringCentroid(p.polygons[0].outer));
  return buildings.filter((b) => {
    if (b.isPart) return true;
    if (b.tags["building:part"]) return true; // edificio que además es su propia parte
    return !partCentroids.some((c) => b.polygons.some((poly) => pointInPolygon(c, poly)));
  });
}

/** Descarga datos de OSM probando varios servidores Overpass públicos. */
export async function fetchOsm(bbox: BBox, progress: ProgressFn, signal?: AbortSignal): Promise<OsmData> {
  const body = "data=" + encodeURIComponent(buildOverpassQuery(bbox));
  let lastError: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      progress(`OpenStreetMap: consultando ${new URL(url).host}…`);
      // un servidor colgado no debe bloquear el resto: se corta a los 60 s y se prueba el siguiente
      const timeout = AbortSignal.timeout(OVERPASS_TIMEOUT_MS);
      const res = await fetch(url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = parseOverpass(json);
      progress(
        `OpenStreetMap: ${data.buildings.length} edificios, ${data.roads.length} vías, ${data.areas.length} áreas`,
      );
      return data;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      progress(`OpenStreetMap: ${new URL(url).host} falló (${(err as Error).message}), probando otro…`);
    }
  }
  throw new Error(`No se pudo obtener datos de OpenStreetMap: ${(lastError as Error)?.message}`);
}
