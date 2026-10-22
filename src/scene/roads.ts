import * as THREE from "three";
import type { LocalFrame } from "../geo/mercator";
import type { LineFeature } from "../data/osm";
import type { TerrainSurface } from "./terrainMesh";
import { clipPolyline } from "../geo/polygon";

interface RoadStyle {
  width: number;
  color: number;
}

const ROAD_STYLES: Record<string, RoadStyle> = {
  motorway: { width: 14, color: 0x5a5f66 },
  trunk: { width: 12, color: 0x5a5f66 },
  primary: { width: 10, color: 0x62666d },
  secondary: { width: 9, color: 0x676b72 },
  tertiary: { width: 8, color: 0x6c7077 },
  unclassified: { width: 6, color: 0x72767c },
  residential: { width: 6, color: 0x72767c },
  living_street: { width: 5, color: 0x7d8086 },
  service: { width: 4, color: 0x7d8086 },
  pedestrian: { width: 5, color: 0xb7aea0 },
  track: { width: 3, color: 0x9c8a6c },
  footway: { width: 2, color: 0xc9bfae },
  path: { width: 1.5, color: 0xb9a98c },
  cycleway: { width: 2, color: 0xa7b5c4 },
  steps: { width: 2, color: 0xc9bfae },
};
const RAIL_STYLE: RoadStyle = { width: 2.5, color: 0x4a3f38 };

export function roadStyle(tags: Record<string, string>): RoadStyle {
  const base = (tags.highway ?? "").replace(/_link$/, "");
  const s = ROAD_STYLES[base] ?? { width: 4, color: 0x7d8086 };
  const lanes = parseFloat(tags.lanes ?? "");
  const width = parseFloat(tags.width ?? "");
  if (Number.isFinite(width) && width > 0) return { ...s, width };
  if (Number.isFinite(lanes) && lanes > 0) return { ...s, width: Math.max(s.width, lanes * 3.2) };
  return s;
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

/** Cintas de vías y vías férreas apoyadas sobre el terreno, todas en una sola malla. */
export function buildRoads(roads: LineFeature[], rails: LineFeature[], frame: LocalFrame, surface: TerrainSurface): THREE.Mesh | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();
  const step = Math.max(2, surface.cellSize);
  const add = (f: LineFeature, style: RoadStyle, lift: number) => {
    if (f.tags.tunnel && f.tags.tunnel !== "no") return;
    const local = f.points.map((p) => frame.toLocal(p.lng, p.lat));
    for (const run of clipPolyline(local, surface)) {
      addRun(f, style, lift, densify(run.map(([x, y]) => new THREE.Vector2(x, y)), step));
    }
  };
  const addRun = (f: LineFeature, style: RoadStyle, lift: number, pts: THREE.Vector2[]) => {
    const bridge = !!f.tags.bridge && f.tags.bridge !== "no";
    const hStart = surface.heightAt(pts[0].x, pts[0].y);
    const hEnd = surface.heightAt(pts[pts.length - 1].x, pts[pts.length - 1].y);
    // acumular longitud para interpolar los puentes entre sus estribos
    const lengths = [0];
    for (let k = 1; k < pts.length; k++) lengths.push(lengths[k - 1] + pts[k].distanceTo(pts[k - 1]));
    const total = lengths[lengths.length - 1] || 1;
    const layer = parseFloat(f.tags.layer ?? "0") || 0;
    color.setHex(style.color, THREE.SRGBColorSpace);
    const first = positions.length / 3;
    const hw = style.width / 2;
    for (let k = 0; k < pts.length; k++) {
      const prev = pts[Math.max(0, k - 1)];
      const next = pts[Math.min(pts.length - 1, k + 1)];
      const dir = new THREE.Vector2().subVectors(next, prev).normalize();
      const nx = -dir.y * hw;
      const ny = dir.x * hw;
      const p = pts[k];
      const y = bridge
        ? hStart + (hEnd - hStart) * (lengths[k] / total) + Math.max(0, layer) * 0.5 + lift
        : surface.heightAt(p.x, p.y) + lift + Math.max(0, layer) * 0.05;
      positions.push(p.x + nx, y, -(p.y + ny), p.x - nx, y, -(p.y - ny));
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      if (k > 0) {
        const a = first + (k - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  };
  for (const r of roads) add(r, roadStyle(r.tags), 0.25);
  for (const r of rails) add(r, RAIL_STYLE, 0.35);
  if (!indices.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
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
