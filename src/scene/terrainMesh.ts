import * as THREE from "three";
import type { BBox } from "../types";
import type { LocalFrame } from "../geo/mercator";
import type { ElevationSampler } from "../data/terrain";

/** Superficie del terreno en coordenadas locales, consultable sin volver a la fuente. */
export class TerrainSurface {
  constructor(
    readonly minX: number,
    readonly minY: number,
    readonly maxX: number,
    readonly maxY: number,
    readonly cols: number,
    readonly rows: number,
    /** Alturas relativas al origen vertical, fila 0 = norte. */
    readonly heights: Float32Array,
    /** Cota absoluta (m s. n. m.) correspondiente a y = 0 en la escena. */
    readonly baseElevation: number,
    readonly minHeight: number,
    readonly maxHeight: number,
  ) {}

  get width() {
    return this.maxX - this.minX;
  }

  get depth() {
    return this.maxY - this.minY;
  }

  /** Altura (y de la escena) en el punto local (este, norte). */
  heightAt(east: number, north: number): number {
    const fx = ((east - this.minX) / this.width) * (this.cols - 1);
    const fy = ((this.maxY - north) / this.depth) * (this.rows - 1);
    const x = Math.min(Math.max(fx, 0), this.cols - 1);
    const y = Math.min(Math.max(fy, 0), this.rows - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, this.cols - 1);
    const y1 = Math.min(y0 + 1, this.rows - 1);
    const tx = x - x0;
    const ty = y - y0;
    const h = this.heights;
    const c = this.cols;
    return (
      h[y0 * c + x0] * (1 - tx) * (1 - ty) +
      h[y0 * c + x1] * tx * (1 - ty) +
      h[y1 * c + x0] * (1 - tx) * ty +
      h[y1 * c + x1] * tx * ty
    );
  }

  /** Tamaño de celda en metros. */
  get cellSize() {
    return this.width / (this.cols - 1);
  }
}

/** Salto máximo (m) respecto a los vecinos antes de considerar un valor como pico erróneo. */
const SPIKE_THRESHOLD = 20;
/** Profundidad máxima (m) que se conserva bajo el nivel del mar en zonas de tierra. */
const MAX_DEPTH = 25;

function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
}

/**
 * Limpia artefactos típicos de los DEM globales:
 * - batimetría de baja resolución en ríos y estuarios (p. ej. −424 m en el Guayas):
 *   se acota la profundidad salvo que la zona entera esté bajo el nivel del mar;
 * - picos o pozos aislados: se sustituyen por la mediana de sus 8 vecinos.
 */
export function cleanElevations(h: Float32Array, cols: number, rows: number) {
  const sample: number[] = [];
  for (let k = 0; k < h.length; k += Math.max(1, Math.floor(h.length / 4000))) sample.push(h[k]);
  if (median(sample) > -MAX_DEPTH) {
    for (let k = 0; k < h.length; k++) if (h[k] < -MAX_DEPTH) h[k] = -MAX_DEPTH;
  }
  const src = h.slice();
  const nb: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      nb.length = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const x = i + di;
          const y = j + dj;
          if (x >= 0 && y >= 0 && x < cols && y < rows) nb.push(src[y * cols + x]);
        }
      }
      const m = median(nb);
      const k = j * cols + i;
      if (!Number.isFinite(src[k]) || Math.abs(src[k] - m) > SPIKE_THRESHOLD) h[k] = m;
    }
  }
}

/** Muestrea la elevación en una rejilla regular sobre la zona. */
export function sampleSurface(bbox: BBox, frame: LocalFrame, sampler: ElevationSampler, maxSegments = 512): TerrainSurface {
  const [minX, minY] = frame.toLocal(bbox.west, bbox.south);
  const [maxX, maxY] = frame.toLocal(bbox.east, bbox.north);
  const w = maxX - minX;
  const d = maxY - minY;
  // celda mínima de 2 m: por debajo no hay ganancia con DEM globales
  const cell = Math.max(2, Math.max(w, d) / maxSegments);
  const cols = Math.max(2, Math.round(w / cell) + 1);
  const rows = Math.max(2, Math.round(d / cell) + 1);
  const raw = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const north = maxY - (j / (rows - 1)) * d;
    for (let i = 0; i < cols; i++) {
      const east = minX + (i / (cols - 1)) * w;
      const ll = frame.toLngLat(east, north);
      const v = sampler.elevation(ll.lng, ll.lat);
      raw[j * cols + i] = Number.isFinite(v) ? v : NaN;
    }
  }
  cleanElevations(raw, cols, rows);
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  const base = min;
  for (let k = 0; k < raw.length; k++) raw[k] = Number.isFinite(raw[k]) ? raw[k] - base : 0;
  return new TerrainSurface(minX, minY, maxX, maxY, cols, rows, raw, base, 0, max - base);
}

/** Malla del terreno con zócalo lateral (aspecto de maqueta, útil también para impresión 3D). */
export function buildTerrainMesh(surface: TerrainSurface, texture: THREE.Texture | null): THREE.Group {
  const { cols, rows, heights } = surface;
  const geo = new THREE.PlaneGeometry(surface.width, surface.depth, cols - 1, rows - 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(surface.minX + surface.width / 2, 0, -(surface.minY + surface.depth / 2));
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) pos.setY(k, heights[k]);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    color: texture ? 0xffffff : 0xb9c79a,
    roughness: 0.95,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "terreno";
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.name = "terreno";
  group.add(mesh, buildSkirt(surface));
  return group;
}

function buildSkirt(s: TerrainSurface): THREE.Mesh {
  const bottom = s.minHeight - Math.max(10, (s.maxHeight - s.minHeight) * 0.15);
  const positions: number[] = [];
  const x = (i: number) => s.minX + (i / (s.cols - 1)) * s.width;
  const z = (j: number) => -(s.maxY - (j / (s.rows - 1)) * s.depth);
  const h = (i: number, j: number) => s.heights[j * s.cols + i];
  const edge = (pts: [number, number, number][]) => {
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay, az] = pts[k];
      const [bx, by, bz] = pts[k + 1];
      positions.push(ax, ay, az, ax, bottom, az, bx, by, bz, bx, by, bz, ax, bottom, az, bx, bottom, bz);
    }
  };
  const north: [number, number, number][] = [];
  const south: [number, number, number][] = [];
  const west: [number, number, number][] = [];
  const east: [number, number, number][] = [];
  for (let i = 0; i < s.cols; i++) {
    north.push([x(i), h(i, 0), z(0)]);
    south.push([x(i), h(i, s.rows - 1), z(s.rows - 1)]);
  }
  for (let j = 0; j < s.rows; j++) {
    west.push([x(0), h(0, j), z(j)]);
    east.push([x(s.cols - 1), h(s.cols - 1, j), z(j)]);
  }
  edge(north.reverse());
  edge(south);
  edge(west);
  edge(east.reverse());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x7a6650, roughness: 1, side: THREE.DoubleSide }));
  mesh.name = "zocalo";
  return mesh;
}
