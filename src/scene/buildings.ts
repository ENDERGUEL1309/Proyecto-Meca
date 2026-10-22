import * as THREE from "three";
import type { LocalFrame } from "../geo/mercator";
import { minAreaRect, openRing, ringArea, type OrientedRect } from "../geo/polygon";
import { buildingHeight, parseLength, type BuildingHeight, type HeightOptions } from "../data/heights";
import type { BuildingFeature } from "../data/osm";
import type { Tags } from "../types";
import type { TerrainSurface } from "./terrainMesh";

export interface HeightOverride {
  min?: number;
  max?: number;
}

export interface BuildingOptions extends HeightOptions {
  /** Cubiertas inclinadas automáticas en viviendas pequeñas sin `roof:shape`. */
  autoRoofs: boolean;
}

export interface BuildingRecord {
  feature: BuildingFeature;
  height: BuildingHeight;
  roof: RoofType;
  /** Rangos de triángulos [inicio, fin] de este edificio en la malla combinada. */
  spans: [number, number][];
}

export type RoofType = "flat" | "gabled" | "hipped" | "pyramidal";

/** Ancho de un módulo de fachada (una ventana) en metros. */
export const FACADE_BAY = 3.5;

const WALL_DEFAULT = new THREE.Color(0xf1ebe0);
const WALL_ESTIMATED = new THREE.Color(0xdfe3e8);
// cubierta algo más oscura que el muro: el volumen se lee bien desde arriba
const ROOF_DEFAULT = new THREE.Color(0xa59c92);
const EDGE_COLOR = 0x3a3530;
const WHITE = new THREE.Color(1, 1, 1);

function tagColor(value: string | undefined, fallback: THREE.Color): THREE.Color {
  if (!value) return fallback;
  // setStyle deja el color intacto (con un aviso) si no reconoce el valor
  return fallback.clone().setStyle(value.replace(/_/g, ""), THREE.SRGBColorSpace);
}

const SMALL_RESIDENTIAL = new Set(["house", "detached", "semidetached_house", "bungalow", "terrace", "hut", "cabin", "farm", "static_caravan"]);

interface RoofPlan {
  type: RoofType;
  rect: OrientedRect | null;
  height: number;
  /** La altura de cubierta viene incluida en la altura del edificio (S3DB). */
  included: boolean;
}

/** Decide la forma de cubierta según `roof:shape` o, opcionalmente, por tipo de edificio. */
export function planRoof(tags: Tags, footprint: [number, number][], source: BuildingHeight["source"], opts: BuildingOptions): RoofPlan {
  const flat: RoofPlan = { type: "flat", rect: null, height: 0, included: true };
  const tag = tags["roof:shape"];
  let type: RoofType | null = null;
  if (tag === "gabled" || tag === "hipped" || tag === "pyramidal") type = tag;
  else if (tag === "half-hipped" || tag === "side_hipped") type = "hipped";
  else if (!tag && opts.autoRoofs) {
    const kind = tags.building ?? "";
    const levels = parseFloat(tags["building:levels"] ?? "1");
    if (SMALL_RESIDENTIAL.has(kind) && levels <= 3 && ringArea(footprint) < 400) type = "hipped";
  }
  if (!type) return flat;

  const rect = minAreaRect(footprint);
  if (!rect || rect.width < 2) return flat;
  if (type !== "pyramidal") {
    // cubiertas de faldones solo sobre plantas casi rectangulares
    if (ringArea(footprint) / (rect.length * rect.width) < 0.75) return flat;
    if (!tag && rect.length / rect.width > 1.6) type = "gabled";
    if (tags["roof:orientation"] === "across") {
      rect.axis = [-rect.axis[1], rect.axis[0]];
      [rect.length, rect.width] = [rect.width, rect.length];
    }
  }
  const lh = opts.levelHeight;
  const tagged = parseLength(tags["roof:height"]) ?? (tags["roof:levels"] ? parseFloat(tags["roof:levels"]) * lh : null);
  const height = tagged ?? Math.min(rect.width * (type === "pyramidal" ? 0.4 : 0.35), 5);
  // con `height` real o con datos de cubierta, la cubierta ya está dentro de la altura total
  const included = source === "height" || tagged !== null;
  return { type, rect, height, included };
}

/** Acumulador de triángulos no indexados. */
class Tris {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];

  get count() {
    return this.pos.length / 9;
  }

  /** Añade un triángulo; `facing` fuerza la normal hacia arriba o hacia fuera de un punto. */
  add(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uv: (p: THREE.Vector3) => [number, number], color: THREE.Color, facing: "up" | THREE.Vector3) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    let flip: boolean;
    if (facing === "up") flip = n.y < 0;
    else {
      const centroid = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3);
      flip = n.x * (centroid.x - facing.x) + n.z * (centroid.z - facing.z) < 0;
    }
    if (flip) {
      [b, c] = [c, b];
      n.negate();
    }
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(...uv(p));
      this.col.push(color.r, color.g, color.b);
    }
  }

  /** Copia los triángulos de un rango de una geometría no indexada. */
  copy(geo: THREE.BufferGeometry, start: number, count: number, uv: (k: number) => [number, number], color: THREE.Color, filter?: (k: number) => boolean) {
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    for (let t = start; t < start + count; t += 3) {
      if (filter && !filter(t)) continue;
      for (let k = t; k < t + 3; k++) {
        this.pos.push(pos.getX(k), pos.getY(k), pos.getZ(k));
        this.nor.push(nor.getX(k), nor.getY(k), nor.getZ(k));
        this.uv.push(...uv(k));
        this.col.push(color.r, color.g, color.b);
      }
    }
  }
}

/**
 * Extruye todos los edificios en una única malla con dos materiales:
 * cubiertas (con la ortofoto proyectada, que muestra el tejado real) y
 * fachadas (ventanas alineadas con las plantas). Pocas llamadas de dibujo
 * aunque haya miles de edificios.
 */
export function buildBuildings(
  features: BuildingFeature[],
  frame: LocalFrame,
  surface: TerrainSurface,
  opts: BuildingOptions,
  overrides: Map<string, HeightOverride>,
  hidden: Set<string>,
  /** Ortofoto para proyectar en las cubiertas; null = color sólido. */
  roofTexture: THREE.Texture | null,
  /** Textura de ventanas; null = muros lisos. */
  facade: THREE.Texture | null,
): { mesh: THREE.Mesh | null; records: BuildingRecord[] } {
  const roofs = new Tris();
  const walls = new Tris();
  const records: BuildingRecord[] = [];
  const wallSpans: [BuildingRecord, number, number][] = [];
  const terrainUV = (x: number, z: number): [number, number] => [
    (x - surface.minX) / surface.width,
    (-z - surface.minY) / surface.depth,
  ];
  const v3 = (p: [number, number], y: number) => new THREE.Vector3(p[0], y, -p[1]);

  for (const f of features) {
    if (hidden.has(f.id)) continue;
    const base = buildingHeight(f.tags, opts);
    const ov = overrides.get(f.id);
    const height: BuildingHeight = ov ? { min: ov.min ?? base.min, max: ov.max ?? base.max, source: "height" } : base;
    const wallColor = tagColor(f.tags["building:colour"], base.source === "default" ? WALL_ESTIMATED : WALL_DEFAULT);
    const roofColor = roofTexture ? WHITE : tagColor(f.tags["roof:colour"], ROOF_DEFAULT);
    const rec: BuildingRecord = { feature: f, height, roof: "flat", spans: [] };
    const roofStart = roofs.count;
    const wallStart = walls.count;

    for (const poly of f.polygons) {
      const outer = openRing(poly.outer).map((p) => frame.toLocal(p.lng, p.lat));
      if (outer.length < 3) continue;
      // asentar en el punto más bajo del terreno bajo la planta: nunca queda flotando
      let ground = Infinity;
      for (const [x, y] of outer) ground = Math.min(ground, surface.heightAt(x, y));
      const bottom = ground + height.min;
      let top = ground + height.max;
      const roof = planRoof(f.tags, outer, height.source, opts);
      let eave = top;
      if (roof.type !== "flat") {
        if (roof.included) eave = top - roof.height;
        else top = eave + roof.height;
        if (eave - bottom < 1.5) {
          eave = top;
          roof.type = "flat";
        }
      }
      rec.roof = roof.type;

      const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
      shape.holes = poly.holes
        .map((h) => new THREE.Path(openRing(h).map((p) => new THREE.Vector2(...frame.toLocal(p.lng, p.lat)))))
        .filter((p) => p.getPoints().length >= 3);
      let geo: THREE.BufferGeometry;
      try {
        geo = new THREE.ExtrudeGeometry(shape, { depth: eave - bottom, bevelEnabled: false, steps: 1 });
      } catch {
        continue;
      }
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, bottom, 0);
      const pos = geo.attributes.position;
      const uvs = geo.attributes.uv;
      for (const g of geo.groups) {
        if (g.materialIndex === 1) {
          // muros: u = coordenada horizontal en metros (la genera Three), v = altura sobre la base
          walls.copy(geo, g.start, g.count, (k) => [uvs.getX(k), pos.getY(k) - bottom], wallColor);
        } else if (roof.type === "flat") {
          // solo la tapa superior; la inferior queda enterrada
          roofs.copy(geo, g.start, g.count, (k) => terrainUV(pos.getX(k), pos.getZ(k)), roofColor, (t) => geo.attributes.normal.getY(t) > 0.5);
        }
      }
      geo.dispose();

      if (roof.type !== "flat" && roof.rect) {
        const { center: c, axis: a, length: L, width: W } = roof.rect;
        const p: [number, number] = [-a[1], a[0]];
        const at = (s: number, t: number): [number, number] => [c[0] + a[0] * s + p[0] * t, c[1] + a[1] * s + p[1] * t];
        const ruv = (q: THREE.Vector3) => terrainUV(q.x, q.z);
        // los hastiales están en los extremos, perpendiculares al eje: u = posición a lo largo de p
        const wuv = (q: THREE.Vector3): [number, number] => [q.x * p[0] - q.z * p[1], q.y - bottom];
        const mid = v3(c, eave);
        const ridge = eave + roof.height;
        if (roof.type === "pyramidal") {
          const apex = v3(c, ridge);
          for (let i = 0; i < outer.length; i++) {
            roofs.add(v3(outer[i], eave), v3(outer[(i + 1) % outer.length], eave), apex, ruv, roofColor, "up");
          }
        } else {
          const A = v3(at(-L / 2, -W / 2), eave);
          const B = v3(at(L / 2, -W / 2), eave);
          const C = v3(at(L / 2, W / 2), eave);
          const D = v3(at(-L / 2, W / 2), eave);
          const inset = roof.type === "hipped" ? Math.min(W / 2, L / 2) : 0;
          const R1 = v3(at(-L / 2 + inset, 0), ridge);
          const R2 = v3(at(L / 2 - inset, 0), ridge);
          roofs.add(A, B, R2, ruv, roofColor, "up");
          roofs.add(A, R2, R1, ruv, roofColor, "up");
          roofs.add(D, R1, R2, ruv, roofColor, "up");
          roofs.add(D, R2, C, ruv, roofColor, "up");
          if (roof.type === "hipped") {
            roofs.add(D, A, R1, ruv, roofColor, "up");
            roofs.add(B, C, R2, ruv, roofColor, "up");
          } else {
            // hastiales: triángulos verticales de fachada
            walls.add(A, D, R1, wuv, wallColor, mid);
            walls.add(B, C, R2, wuv, wallColor, mid);
          }
        }
      }
    }
    if (roofs.count > roofStart) rec.spans.push([roofStart, roofs.count - 1]);
    if (walls.count > wallStart) wallSpans.push([rec, wallStart, walls.count - 1]);
    if (roofs.count > roofStart || walls.count > wallStart) records.push(rec);
  }
  if (!roofs.count && !walls.count) return { mesh: null, records };

  // cubiertas primero, fachadas después: un grupo por material
  const offset = roofs.count;
  for (const [rec, s, e] of wallSpans) rec.spans.push([s + offset, e + offset]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(roofs.pos.concat(walls.pos), 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(roofs.nor.concat(walls.nor), 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(roofs.uv.concat(walls.uv), 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(roofs.col.concat(walls.col), 3));
  geo.addGroup(0, roofs.count * 3, 0);
  geo.addGroup(roofs.count * 3, walls.count * 3, 1);

  facade?.repeat.set(1 / FACADE_BAY, 1 / opts.levelHeight);
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTexture, vertexColors: true, roughness: 0.9 });
  roofMat.name = "cubiertas";
  const wallMat = new THREE.MeshStandardMaterial({ map: facade, vertexColors: true, roughness: 0.7, metalness: 0.05 });
  wallMat.name = "fachadas";
  const mesh = new THREE.Mesh(geo, [roofMat, wallMat]);
  mesh.name = "edificios";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // aristas marcadas (esquinas, aleros, cumbreras): separan cada edificio del fondo
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 30),
    new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.45 }),
  );
  edges.name = "aristas";
  mesh.add(edges);
  return { mesh, records };
}

/** Busca el edificio al que pertenece un triángulo (búsqueda binaria sobre los rangos). */
export function recordForFace(records: BuildingRecord[], faceIndex: number): BuildingRecord | null {
  const spans = spanIndex(records);
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e, r] = spans[mid];
    if (faceIndex < s) hi = mid - 1;
    else if (faceIndex > e) lo = mid + 1;
    else return r;
  }
  return null;
}

const spanCache = new WeakMap<BuildingRecord[], [number, number, BuildingRecord][]>();
function spanIndex(records: BuildingRecord[]) {
  let idx = spanCache.get(records);
  if (!idx) {
    idx = records.flatMap((r) => r.spans.map(([s, e]) => [s, e, r] as [number, number, BuildingRecord]));
    idx.sort((a, b) => a[0] - b[0]);
    spanCache.set(records, idx);
  }
  return idx;
}
