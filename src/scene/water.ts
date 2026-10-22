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

/** Lagos, esteros y ríos: superficies planas con reflejos y líneas de río drapeadas. */
export function buildWater(areas: AreaFeature[], waterways: LineFeature[], frame: LocalFrame, surface: TerrainSurface): THREE.Group | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const a of areas) {
    if (a.kind !== "water") continue;
    for (const poly of a.polygons) {
      const outer = clipRing(openRing(poly.outer).map((p) => frame.toLocal(p.lng, p.lat)), surface);
      if (outer.length < 3) continue;
      const level = waterLevel(outer.map(([x, y]) => surface.heightAt(x, y)));
      const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of poly.holes) {
        const hole = clipRing(openRing(h).map((p) => frame.toLocal(p.lng, p.lat)), surface);
        if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
      }
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, level + 0.3, 0);
      geos.push(geo);
    }
  }
  const group = new THREE.Group();
  group.name = "agua";
  const mat = waterMaterial();
  for (const g of geos) {
    const m = new THREE.Mesh(g, mat);
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
