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

/** Recorta un anillo (en coordenadas locales) a un rectángulo: Sutherland–Hodgman. */
export function clipRing(ring: [number, number][], r: Rect): [number, number][] {
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= r.minX, (a, b) => lerpAt(a, b, 0, r.minX)],
    [(p) => p[0] <= r.maxX, (a, b) => lerpAt(a, b, 0, r.maxX)],
    [(p) => p[1] >= r.minY, (a, b) => lerpAt(a, b, 1, r.minY)],
    [(p) => p[1] <= r.maxY, (a, b) => lerpAt(a, b, 1, r.maxY)],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cut(prev, cur));
      }
    }
    if (!out.length) break;
  }
  return out;
}

function lerpAt(a: [number, number], b: [number, number], axis: 0 | 1, value: number): [number, number] {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Envolvente convexa (cadena monótona de Andrew). */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface OrientedRect {
  center: [number, number];
  /** Vector unitario del lado largo. */
  axis: [number, number];
  length: number;
  width: number;
}

/** Rectángulo orientado de área mínima (calibres rotatorios sobre la envolvente). */
export function minAreaRect(points: [number, number][]): OrientedRect | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let best: OrientedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const center: [number, number] = [cu * ux - cv * uy, cu * uy + cv * ux];
      const du = maxU - minU;
      const dv = maxV - minV;
      best = du >= dv
        ? { center, axis: [ux, uy], length: du, width: dv }
        : { center, axis: [-uy, ux], length: dv, width: du };
    }
  }
  return best;
}
