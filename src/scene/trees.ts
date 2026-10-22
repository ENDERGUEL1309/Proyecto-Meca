import * as THREE from "three";
import type { LocalFrame } from "../geo/mercator";
import type { Ring } from "../types";
import type { OsmData } from "../data/osm";
import { seededRandom } from "../geo/random";
import { roadStyle } from "./roads";
import type { TerrainSurface } from "./terrainMesh";

/** Separación media entre árboles candidatos, en metros. */
const SPACING = 6;

/**
 * Índice de verdor (Excess Green normalizado) y luminancia de un píxel.
 * Las copas de árboles son verdes y oscuras; el césped es verde pero claro.
 */
export function vegetationScore(r: number, g: number, b: number): { exg: number; lum: number } {
  const sum = r + g + b + 1;
  return { exg: (2 * g - r - b) / sum, lum: (0.299 * r + 0.587 * g + 0.114 * b) / 255 };
}

/** Probabilidad de que haya un árbol según la ortofoto. */
export function treeProbabilityFromPixel(r: number, g: number, b: number): number {
  const { exg, lum } = vegetationScore(r, g, b);
  if (exg > 0.04 && lum < 0.38) return 0.85;
  if (exg > 0.07 && lum < 0.5) return 0.25;
  return 0;
}

class Raster {
  readonly w: number;
  readonly h: number;
  readonly ctx: CanvasRenderingContext2D;
  private data: Uint8ClampedArray | null = null;

  constructor(private readonly surface: TerrainSurface, private readonly frame: LocalFrame, maxPx = 2048) {
    const scale = Math.min(1 / 2, maxPx / Math.max(surface.width, surface.depth)); // ≥ 2 m por píxel
    this.w = Math.max(1, Math.round(surface.width * scale));
    this.h = Math.max(1, Math.round(surface.depth * scale));
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    this.ctx = c.getContext("2d", { willReadFrequently: true })!;
  }

  px(lng: number, lat: number): [number, number] {
    const [x, y] = this.frame.toLocal(lng, lat);
    return [((x - this.surface.minX) / this.surface.width) * this.w, ((this.surface.maxY - y) / this.surface.depth) * this.h];
  }

  path(ring: Ring) {
    ring.forEach((p, i) => {
      const [x, y] = this.px(p.lng, p.lat);
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });
    this.ctx.closePath();
  }

  /** Valor del canal rojo en el punto local (este, norte). */
  at(east: number, north: number): number {
    this.data ??= this.ctx.getImageData(0, 0, this.w, this.h).data;
    const i = Math.floor(((east - this.surface.minX) / this.surface.width) * this.w);
    const j = Math.floor(((this.surface.maxY - north) / this.surface.depth) * this.h);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
    return this.data[(j * this.w + i) * 4];
  }
}

export interface TreeOptions {
  maxTrees: number;
  imagery: HTMLCanvasElement | null;
}

/**
 * Árboles instanciados (dos llamadas de dibujo para miles de árboles).
 * Fuentes: árboles sueltos de OSM, bosques y parques de OSM y, si hay ortofoto,
 * detección de copas por color. Se excluyen edificios, vías y agua.
 */
export function buildTrees(osm: OsmData | null, frame: LocalFrame, surface: TerrainSurface, opts: TreeOptions): THREE.Group | null {
  const rnd = seededRandom(Math.round(surface.baseElevation * 1000 + surface.width));

  // máscara de zonas ocupadas (rojo = ocupado)
  const blocked = new Raster(surface, frame);
  // máscara de vegetación (rojo: 255 = bosque, 80 = parque o césped)
  const veg = new Raster(surface, frame);
  if (osm) {
    const b = blocked.ctx;
    b.fillStyle = b.strokeStyle = "#f00";
    b.lineCap = "round";
    const metersPerPx = surface.width / blocked.w;
    for (const r of osm.roads) {
      b.beginPath();
      r.points.forEach((p, i) => {
        const [x, y] = blocked.px(p.lng, p.lat);
        if (i === 0) b.moveTo(x, y);
        else b.lineTo(x, y);
      });
      b.lineWidth = (roadStyle(r.tags).width + 3) / metersPerPx;
      b.stroke();
    }
    b.beginPath();
    for (const bd of osm.buildings) for (const poly of bd.polygons) blocked.path(poly.outer);
    for (const a of osm.areas) if (a.kind === "water") for (const poly of a.polygons) blocked.path(poly.outer);
    b.fill();
    b.lineWidth = 3 / metersPerPx;
    b.stroke();

    for (const kind of ["green", "forest"] as const) {
      veg.ctx.fillStyle = kind === "forest" ? "rgb(255,0,0)" : "rgb(80,0,0)";
      veg.ctx.beginPath();
      for (const a of osm.areas) {
        if (a.kind !== kind) continue;
        for (const poly of a.polygons) {
          veg.path(poly.outer);
          poly.holes.forEach((h) => veg.path(h));
        }
      }
      veg.ctx.fill("evenodd");
    }
  }

  let img: Uint8ClampedArray | null = null;
  let iw = 0;
  let ih = 0;
  if (opts.imagery) {
    iw = opts.imagery.width;
    ih = opts.imagery.height;
    img = opts.imagery.getContext("2d")!.getImageData(0, 0, iw, ih).data;
  }
  const pixel = (east: number, north: number): [number, number, number] | null => {
    if (!img) return null;
    const i = Math.min(iw - 1, Math.max(0, Math.floor(((east - surface.minX) / surface.width) * iw)));
    const j = Math.min(ih - 1, Math.max(0, Math.floor(((surface.maxY - north) / surface.depth) * ih)));
    const k = (j * iw + i) * 4;
    return [img[k], img[k + 1], img[k + 2]];
  };

  interface Tree { x: number; y: number; h: number; color: THREE.Color }
  const trees: Tree[] = [];
  const palette = [0x3f6b2f, 0x4d7a35, 0x355e2a, 0x5a8040].map((c) => new THREE.Color(c));
  const colorFor = (x: number, y: number) => {
    const p = pixel(x, y);
    if (!p) return palette[Math.floor(rnd() * palette.length)].clone();
    // la ortofoto es algo oscura vista desde arriba: se aclara un poco la copa
    return new THREE.Color().setRGB((p[0] / 255) * 1.05, (p[1] / 255) * 1.12, (p[2] / 255) * 0.95, THREE.SRGBColorSpace);
  };

  for (const t of osm?.trees ?? []) {
    const [x, y] = frame.toLocal(t.lng, t.lat);
    if (x < surface.minX || x > surface.maxX || y < surface.minY || y > surface.maxY) continue;
    trees.push({ x, y, h: 7 + rnd() * 6, color: colorFor(x, y) });
  }

  for (let y = surface.minY + SPACING / 2; y < surface.maxY; y += SPACING) {
    for (let x = surface.minX + SPACING / 2; x < surface.maxX; x += SPACING) {
      const jx = x + (rnd() - 0.5) * SPACING * 0.9;
      const jy = y + (rnd() - 0.5) * SPACING * 0.9;
      if (blocked.at(jx, jy) > 128) continue;
      const v = veg.at(jx, jy);
      let p = v > 200 ? 0.9 : v > 40 ? 0.15 : 0;
      const px = pixel(jx, jy);
      if (px) {
        const fromImage = treeProbabilityFromPixel(px[0], px[1], px[2]);
        // dentro de un bosque OSM manda la imagen si muestra claros
        p = v > 200 ? Math.max(fromImage, 0.35) : Math.max(p * 0.5, fromImage);
      }
      if (rnd() >= p) continue;
      const forest = v > 200 || (px !== null && treeProbabilityFromPixel(px[0], px[1], px[2]) > 0.5);
      trees.push({ x: jx, y: jy, h: (forest ? 8 : 5) + rnd() * 7, color: colorFor(jx, jy) });
    }
  }
  if (!trees.length) return null;
  // por encima del máximo se toma una muestra uniforme
  if (trees.length > opts.maxTrees) {
    for (let i = trees.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [trees[i], trees[j]] = [trees[j], trees[i]];
    }
    trees.length = opts.maxTrees;
  }

  const canopyGeo = new THREE.IcosahedronGeometry(1, 1) // 80 triángulos por copa;
  const pos = canopyGeo.attributes.position as THREE.BufferAttribute;
  const shapeRnd = seededRandom(5);
  const bumps = new Map<string, number>();
  for (let k = 0; k < pos.count; k++) {
    // misma deformación para vértices duplicados en la misma posición: sin grietas
    const key = `${pos.getX(k).toFixed(3)},${pos.getY(k).toFixed(3)},${pos.getZ(k).toFixed(3)}`;
    if (!bumps.has(key)) bumps.set(key, 0.82 + shapeRnd() * 0.3);
    const f = bumps.get(key)!;
    pos.setXYZ(k, pos.getX(k) * f, pos.getY(k) * f * 0.85, pos.getZ(k) * f);
  }
  canopyGeo.computeVertexNormals();
  const trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, 6);
  trunkGeo.translate(0, 0.5, 0);

  const canopy = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), trees.length);
  const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 }), trees.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  trees.forEach((t, i) => {
    const ground = surface.heightAt(t.x, t.y);
    const radius = t.h * (0.26 + rnd() * 0.12);
    const trunkH = t.h - radius * 1.4;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
    p.set(t.x, ground + trunkH + radius * 0.55, -t.y);
    s.set(radius, radius, radius);
    canopy.setMatrixAt(i, m.compose(p, q, s));
    canopy.setColorAt(i, t.color);
    p.set(t.x, ground - 0.3, -t.y);
    s.set(t.h * 0.018, trunkH + 0.3 + radius * 0.3, t.h * 0.018);
    trunk.setMatrixAt(i, m.compose(p, q, s));
  });
  canopy.castShadow = trunk.castShadow = true;
  canopy.receiveShadow = true;
  canopy.name = "copas";
  trunk.name = "troncos";
  const group = new THREE.Group();
  group.name = "arboles";
  group.add(canopy, trunk);
  return group;
}
