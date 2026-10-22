import * as THREE from "three";
import type { LocalFrame } from "../geo/mercator";
import { clipRing, openRing } from "../geo/polygon";
import type { AreaFeature, LineFeature } from "../data/osm";
import type { TerrainSurface } from "./terrainMesh";
import { ribbonGeometry, waterwayWidth } from "./roads";
import { waterNormalTexture } from "./textures";

/** Tamaño en metros de una repetición del oleaje. */
const WAVE_TILE = 30;

export function waterMaterial(): THREE.MeshPhysicalMaterial {
  const normalMap = waterNormalTexture();
  normalMap.repeat.set(1 / WAVE_TILE, 1 / WAVE_TILE);
  return new THREE.MeshPhysicalMaterial({
    color: 0x1f4c63,
    roughness: 0.06,
    metalness: 0,
    normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    transparent: true,
    opacity: 0.9,
    envMapIntensity: 1.3,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/**
 * Nivel del agua de un polígono: percentil bajo de las cotas de su orilla.
 * Los DEM suelen registrar la lámina de agua, así que la orilla da el nivel.
 */
export function waterLevel(heights: number[]): number {
  const sorted = [...heights].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.2)] ?? 0;
}

export interface WaterBody {
  outer: [number, number][];
  holes: [number, number][][];
  /** Cota de la lámina (y de la escena). */
  level: number;
}

/** Polígonos de agua en coordenadas locales, recortados a la zona y con su nivel. */
export function waterBodies(areas: AreaFeature[], frame: LocalFrame, surface: TerrainSurface): WaterBody[] {
  const bodies: WaterBody[] = [];
  for (const a of areas) {
    if (a.kind !== "water") continue;
    for (const poly of a.polygons) {
      const outer = clipRing(openRing(poly.outer).map((p) => frame.toLocal(p.lng, p.lat)), surface);
      if (outer.length < 3) continue;
      const holes = poly.holes
        .map((h) => clipRing(openRing(h).map((p) => frame.toLocal(p.lng, p.lat)), surface))
        .filter((h) => h.length >= 3);
      bodies.push({ outer, holes, level: waterLevel(outer.map(([x, y]) => surface.heightAt(x, y))) });
    }
  }
  return bodies;
}

function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Margen bajo la lámina al que se rebaja el terreno dentro del agua, en metros. */
const CARVE_DEPTH = 1.5;

/**
 * Rebaja el terreno bajo cada lámina de agua. Sobre el agua los DEM tienen ruido
 * (reflejos del radar, vegetación de orilla) que asomaría por encima y la taparía.
 */
export function carveWaterBodies(surface: TerrainSurface, bodies: WaterBody[]) {
  const { cols, rows, heights } = surface;
  const dx = surface.width / (cols - 1);
  const dy = surface.depth / (rows - 1);
  for (const b of bodies) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of b.outer) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const i0 = Math.max(0, Math.floor((minX - surface.minX) / dx));
    const i1 = Math.min(cols - 1, Math.ceil((maxX - surface.minX) / dx));
    const j0 = Math.max(0, Math.floor((surface.maxY - maxY) / dy));
    const j1 = Math.min(rows - 1, Math.ceil((surface.maxY - minY) / dy));
    const floor = b.level - CARVE_DEPTH;
    for (let j = j0; j <= j1; j++) {
      const y = surface.maxY - j * dy;
      for (let i = i0; i <= i1; i++) {
        const x = surface.minX + i * dx;
        if (!inRing(x, y, b.outer) || b.holes.some((h) => inRing(x, y, h))) continue;
        const k = j * cols + i;
        if (heights[k] > floor) heights[k] = floor;
      }
    }
  }
}

/** Lagos, esteros y ríos: superficies planas con reflejos y cauces drapeados. */
export function buildWater(bodies: WaterBody[], waterways: LineFeature[], frame: LocalFrame, surface: TerrainSurface): THREE.Group | null {
  const group = new THREE.Group();
  group.name = "agua";
  const mat = waterMaterial();
  for (const b of bodies) {
    const shape = new THREE.Shape(b.outer.map(([x, y]) => new THREE.Vector2(x, y)));
    shape.holes = b.holes.map((h) => new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, b.level + 0.2, 0);
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    group.add(m);
  }
  const rivers = ribbonGeometry(
    waterways.map((f) => ({ feature: f, width: waterwayWidth(f.tags), row: null, lift: 0.3 })),
    frame,
    surface,
  );
  if (rivers) group.add(new THREE.Mesh(rivers, mat));
  return group.children.length ? group : null;
}
