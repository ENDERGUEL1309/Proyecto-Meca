import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { LocalFrame } from "../geo/mercator";
import { openRing } from "../geo/polygon";
import { buildingHeight, type BuildingHeight, type HeightOptions } from "../data/heights";
import type { BuildingFeature } from "../data/osm";
import type { TerrainSurface } from "./terrainMesh";

export interface HeightOverride {
  min?: number;
  max?: number;
}

export interface BuildingRecord {
  feature: BuildingFeature;
  height: BuildingHeight;
  /** Primer y último triángulo de este edificio en la malla combinada. */
  triStart: number;
  triEnd: number;
}

const WALL_DEFAULT = new THREE.Color(0xe8e2d6);
const ROOF_DEFAULT = new THREE.Color(0xb7a99a);
const WALL_ESTIMATED = new THREE.Color(0xd9dde3);

function tagColor(value: string | undefined, fallback: THREE.Color): THREE.Color {
  if (!value) return fallback;
  // setStyle deja el color intacto (con un aviso) si no reconoce el valor
  return fallback.clone().setStyle(value.replace(/_/g, ""), THREE.SRGBColorSpace);
}

function toShape(ring: { lng: number; lat: number }[], frame: LocalFrame): THREE.Vector2[] {
  return openRing(ring).map((p) => {
    const [x, y] = frame.toLocal(p.lng, p.lat);
    return new THREE.Vector2(x, y);
  });
}

/**
 * Extruye todos los edificios y los combina en una única malla (una sola llamada
 * de dibujo), con color por vértice. Devuelve también el índice de triángulos
 * para poder identificar qué edificio se ha seleccionado con el ratón.
 */
export function buildBuildings(
  features: BuildingFeature[],
  frame: LocalFrame,
  surface: TerrainSurface,
  opts: HeightOptions,
  overrides: Map<string, HeightOverride>,
  hidden: Set<string>,
): { mesh: THREE.Mesh | null; records: BuildingRecord[] } {
  const geometries: THREE.BufferGeometry[] = [];
  const records: BuildingRecord[] = [];
  let tri = 0;
  for (const f of features) {
    if (hidden.has(f.id)) continue;
    const base = buildingHeight(f.tags, opts);
    const ov = overrides.get(f.id);
    const height: BuildingHeight = ov
      ? { min: ov.min ?? base.min, max: ov.max ?? base.max, source: "height" }
      : base;
    const wall = tagColor(f.tags["building:colour"], base.source === "default" ? WALL_ESTIMATED : WALL_DEFAULT);
    const roof = tagColor(f.tags["roof:colour"], ROOF_DEFAULT);
    const start = tri;
    for (const poly of f.polygons) {
      const outer = toShape(poly.outer, frame);
      if (outer.length < 3) continue;
      // asentar en el punto más bajo del terreno bajo la planta: nunca queda flotando
      let ground = Infinity;
      for (const v of outer) ground = Math.min(ground, surface.heightAt(v.x, v.y));
      const shape = new THREE.Shape(outer);
      shape.holes = poly.holes.map((h) => new THREE.Path(toShape(h, frame))).filter((p) => p.getPoints().length >= 3);
      const depth = height.max - height.min;
      let geo: THREE.BufferGeometry;
      try {
        geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
      } catch {
        continue;
      }
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, ground + height.min, 0);
      geo.deleteAttribute("uv");
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);
      // grupo 0 = tapas (cubierta y base), grupo 1 = muros
      for (const g of geo.groups) {
        const c = g.materialIndex === 0 ? roof : wall;
        for (let k = g.start; k < g.start + g.count; k++) c.toArray(colors, k * 3);
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.clearGroups();
      geometries.push(geo);
      tri += count / 3;
    }
    if (tri > start) records.push({ feature: f, height, triStart: start, triEnd: tri - 1 });
  }
  if (!geometries.length) return { mesh: null, records };
  const merged = mergeGeometries(geometries, false)!;
  geometries.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02 }),
  );
  mesh.name = "edificios";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, records };
}

/** Busca el edificio al que pertenece un triángulo (búsqueda binaria). */
export function recordForFace(records: BuildingRecord[], faceIndex: number): BuildingRecord | null {
  let lo = 0;
  let hi = records.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = records[mid];
    if (faceIndex < r.triStart) hi = mid - 1;
    else if (faceIndex > r.triEnd) lo = mid + 1;
    else return r;
  }
  return null;
}
