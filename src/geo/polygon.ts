import type { LngLat, Polygon, Ring } from "../types";

const samePoint = (a: LngLat, b: LngLat) => a.lng === b.lng && a.lat === b.lat;

/** Quita el punto de cierre duplicado de un anillo. */
export function openRing(ring: Ring): Ring {
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) return ring.slice(0, -1);
  return ring;
}

export function pointInRing(p: LngLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(p: LngLat, poly: Polygon): boolean {
  return pointInRing(p, poly.outer) && !poly.holes.some((h) => pointInRing(p, h));
}

/** Centroide de área (con respaldo a la media de vértices si el área es nula). */
export function ringCentroid(ring: Ring): LngLat {
  const pts = openRing(ring);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.lng * q.lat - q.lng * p.lat;
    a += cross;
    cx += (p.lng + q.lng) * cross;
    cy += (p.lat + q.lat) * cross;
  }
  if (Math.abs(a) < 1e-18) {
    const n = pts.length || 1;
    return { lng: pts.reduce((s, p) => s + p.lng, 0) / n, lat: pts.reduce((s, p) => s + p.lat, 0) / n };
  }
  return { lng: cx / (3 * a), lat: cy / (3 * a) };
}

/**
 * Une segmentos de vías (miembros de una relación multipolígono) en anillos
 * cerrados, enlazando por extremos coincidentes e invirtiendo cuando hace falta.
 * Los tramos que no logran cerrarse se descartan.
 */
export function assembleRings(segments: LngLat[][]): Ring[] {
  const pending = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: Ring[] = [];
  while (pending.length) {
    let current = pending.shift()!;
    let progressed = true;
    while (!samePoint(current[0], current[current.length - 1]) && progressed) {
      progressed = false;
      const tail = current[current.length - 1];
      for (let i = 0; i < pending.length; i++) {
        const s = pending[i];
        if (samePoint(s[0], tail)) {
          current = current.concat(s.slice(1));
        } else if (samePoint(s[s.length - 1], tail)) {
          current = current.concat(s.slice(0, -1).reverse());
        } else {
          continue;
        }
        pending.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (current.length >= 4 && samePoint(current[0], current[current.length - 1])) rings.push(current);
  }
  return rings;
}

/** Asigna cada anillo interior al exterior que lo contiene. */
export function buildPolygons(outers: Ring[], inners: Ring[]): Polygon[] {
  const polys: Polygon[] = outers.map((outer) => ({ outer, holes: [] }));
  for (const inner of inners) {
    const probe = inner[0];
    const host = polys.find((p) => pointInRing(probe, p.outer));
    if (host) host.holes.push(inner);
  }
  return polys;
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Recorta una polilínea a un rectángulo (Liang–Barsky por segmento) y devuelve
 * los tramos continuos que quedan dentro.
 */
export function clipPolyline(pts: [number, number][], r: Rect): [number, number][][] {
  const runs: [number, number][][] = [];
  let current: [number, number][] | null = null;
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1];
    const [x1, y1] = pts[k];
    const dx = x1 - x0;
    const dy = y1 - y0;
    let t0 = 0;
    let t1 = 1;
    const edges: [number, number][] = [
      [-dx, x0 - r.minX],
      [dx, r.maxX - x0],
      [-dy, y0 - r.minY],
      [dy, r.maxY - y0],
    ];
    let visible = true;
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) visible = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
      if (t0 > t1) visible = false;
      if (!visible) break;
    }
    if (!visible) {
      current = null;
      continue;
    }
    const a: [number, number] = [x0 + t0 * dx, y0 + t0 * dy];
    const b: [number, number] = [x0 + t1 * dx, y0 + t1 * dy];
    if (!current || t0 > 0) {
      current = [a];
      runs.push(current);
    }
    current.push(b);
    if (t1 < 1) current = null;
  }
  return runs.filter((run) => run.length >= 2);
}
