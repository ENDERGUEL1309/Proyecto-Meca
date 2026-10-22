import * as THREE from "three";
import type { LocalFrame } from "../geo/mercator";
import type { LineFeature } from "../data/osm";
import type { TerrainSurface } from "./terrainMesh";
import { clipPolyline } from "../geo/polygon";
import { ROAD_TILE_METERS, roadAtlas, roadRowV, type RoadRow } from "./textures";

interface RoadStyle {
  width: number;
  row: RoadRow;
}

const ROAD_STYLES: Record<string, RoadStyle> = {
  motorway: { width: 14, row: "major" },
  trunk: { width: 12, row: "major" },
  primary: { width: 10, row: "major" },
  secondary: { width: 9, row: "major" },
  tertiary: { width: 8, row: "major" },
  unclassified: { width: 6, row: "minor" },
  residential: { width: 6, row: "minor" },
  living_street: { width: 5, row: "minor" },
  service: { width: 4, row: "minor" },
  pedestrian: { width: 5, row: "path" },
  footway: { width: 2, row: "path" },
  steps: { width: 2, row: "path" },
  cycleway: { width: 2, row: "path" },
  track: { width: 3, row: "track" },
  path: { width: 1.5, row: "track" },
  bridleway: { width: 2, row: "track" },
};

export function roadStyle(tags: Record<string, string>): RoadStyle {
  const base = (tags.highway ?? "").replace(/_link$/, "");
  const s = ROAD_STYLES[base] ?? { width: 4, row: "minor" as RoadRow };
  const lanes = parseFloat(tags.lanes ?? "");
  const width = parseFloat(tags.width ?? "");
  if (Number.isFinite(width) && width > 0) return { ...s, width };
  if (Number.isFinite(lanes) && lanes > 0) return { ...s, width: Math.max(s.width, lanes * 3.2) };
  return s;
}

const WATERWAY_WIDTHS: Record<string, number> = { river: 14, canal: 8, stream: 3, drain: 2, ditch: 1.5 };

export function waterwayWidth(tags: Record<string, string>): number {
  const w = parseFloat(tags.width ?? "");
  return Number.isFinite(w) && w > 0 ? w : WATERWAY_WIDTHS[tags.waterway] ?? 3;
}

export interface Ribbon {
  feature: LineFeature;
  width: number;
  /** Fila del atlas; si es null las UV quedan en metros (para el agua). */
  row: RoadRow | null;
  lift: number;
}

/** Inserta puntos intermedios para que la cinta siga el relieve. */
function densify(pts: THREE.Vector2[], step: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const n = Math.ceil(a.distanceTo(b) / step);
    for (let s = 1; s <= n; s++) out.push(new THREE.Vector2().lerpVectors(a, b, s / n));
  }
  return out;
}

/**
 * Cintas apoyadas en el terreno (vías, ferrocarril, ríos), recortadas a la zona.
 * UV: u = distancia recorrida, v = banda del atlas (o ancho en metros).
 */
export function ribbonGeometry(ribbons: Ribbon[], frame: LocalFrame, surface: TerrainSurface): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const step = Math.max(2, surface.cellSize);

  const addRun = (r: Ribbon, pts: THREE.Vector2[]) => {
    const tags = r.feature.tags;
    const bridge = !!tags.bridge && tags.bridge !== "no";
    const hStart = surface.heightAt(pts[0].x, pts[0].y);
    const hEnd = surface.heightAt(pts[pts.length - 1].x, pts[pts.length - 1].y);
    // acumular longitud para interpolar los puentes entre sus estribos
    const lengths = [0];
    for (let k = 1; k < pts.length; k++) lengths.push(lengths[k - 1] + pts[k].distanceTo(pts[k - 1]));
    const total = lengths[lengths.length - 1] || 1;
    const layer = Math.max(0, parseFloat(tags.layer ?? "0") || 0);
    const [v0, v1] = r.row ? roadRowV(r.row) : [0, r.width];
    const uScale = r.row ? 1 / ROAD_TILE_METERS : 1;
    const first = positions.length / 3;
    const hw = r.width / 2;
    for (let k = 0; k < pts.length; k++) {
      const prev = pts[Math.max(0, k - 1)];
      const next = pts[Math.min(pts.length - 1, k + 1)];
      const dir = new THREE.Vector2().subVectors(next, prev).normalize();
      const nx = -dir.y * hw;
      const ny = dir.x * hw;
      const p = pts[k];
      const y = bridge
        ? hStart + (hEnd - hStart) * (lengths[k] / total) + layer * 0.5 + r.lift
        : surface.heightAt(p.x, p.y) + r.lift + layer * 0.05;
      positions.push(p.x + nx, y, -(p.y + ny), p.x - nx, y, -(p.y - ny));
      const u = lengths[k] * uScale;
      uvs.push(u, v1, u, v0);
      if (k > 0) {
        const a = first + (k - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  };

  for (const r of ribbons) {
    const t = r.feature.tags;
    if (t.tunnel && t.tunnel !== "no") continue;
    if (t.location === "underground" || t.tunnel === "culvert") continue;
    const local = r.feature.points.map((p) => frame.toLocal(p.lng, p.lat));
    for (const run of clipPolyline(local, surface)) {
      addRun(r, densify(run.map(([x, y]) => new THREE.Vector2(x, y)), step));
    }
  }
  if (!indices.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Vías y ferrocarril con texturas de asfalto, señalización, aceras y traviesas. */
export function buildRoads(roads: LineFeature[], rails: LineFeature[], frame: LocalFrame, surface: TerrainSurface): THREE.Mesh | null {
  // las vías más anchas encima: en los cruces se ve la principal
  const ribbons: Ribbon[] = [
    ...roads.map((f) => {
      const s = roadStyle(f.tags);
      return { feature: f, width: s.width, row: s.row, lift: 0.2 + s.width * 0.004 };
    }),
    ...rails.map((f) => ({ feature: f, width: 3, row: "rail" as RoadRow, lift: 0.3 })),
  ];
  const geo = ribbonGeometry(ribbons, frame, surface);
  if (!geo) return null;
  const mat = new THREE.MeshStandardMaterial({
    map: roadAtlas(),
    roughness: 0.85,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "vias";
  mesh.receiveShadow = true;
  return mesh;
}
