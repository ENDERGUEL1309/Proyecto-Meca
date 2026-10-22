import type { BBox, LngLat } from "../types";

/** Radio terrestre usado por Web Mercator (EPSG:3857). */
export const EARTH_RADIUS = 6378137;
const MAX_LAT = 85.0511287798;

export function lngLatToMercator(lng: number, lat: number): { x: number; y: number } {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = (EARTH_RADIUS * lng * Math.PI) / 180;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  return { x, y };
}

export function mercatorToLngLat(x: number, y: number): LngLat {
  const lng = (x / EARTH_RADIUS) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
  return { lng, lat };
}

/** Coordenadas de tesela XYZ fraccionarias (esquema Slippy Map). */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const x = ((lng + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Rango entero de teselas que cubren la caja a un zoom dado. */
export function tileRange(bbox: BBox, z: number) {
  const nw = lngLatToTile(bbox.west, bbox.north, z);
  const se = lngLatToTile(bbox.east, bbox.south, z);
  const minX = Math.floor(nw.x);
  const minY = Math.floor(nw.y);
  const maxX = Math.floor(se.x - 1e-9);
  const maxY = Math.floor(se.y - 1e-9);
  return { minX, minY, maxX, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) };
}

/** Extensión en metros Mercator de una tesela. */
export function tileMercatorBounds(x: number, y: number, z: number) {
  const size = (2 * Math.PI * EARTH_RADIUS) / 2 ** z;
  const minX = -Math.PI * EARTH_RADIUS + x * size;
  const maxY = Math.PI * EARTH_RADIUS - y * size;
  return { minX, maxX: minX + size, minY: maxY - size, maxY };
}

/**
 * Marco local en metros reales centrado en la zona seleccionada.
 * Web Mercator escalado por cos(lat0): conserva ángulos y distancias
 * con error despreciable para áreas de unos pocos kilómetros.
 * Convención de la escena: x = este, y = arriba, z = -norte.
 */
export class LocalFrame {
  readonly center: LngLat;
  readonly scale: number;
  private readonly cx: number;
  private readonly cy: number;

  constructor(bbox: BBox) {
    this.center = { lng: (bbox.west + bbox.east) / 2, lat: (bbox.south + bbox.north) / 2 };
    const c = lngLatToMercator(this.center.lng, this.center.lat);
    this.cx = c.x;
    this.cy = c.y;
    this.scale = Math.cos((this.center.lat * Math.PI) / 180);
  }

  /** Devuelve [este, norte] en metros respecto al centro. */
  toLocal(lng: number, lat: number): [number, number] {
    const m = lngLatToMercator(lng, lat);
    return [(m.x - this.cx) * this.scale, (m.y - this.cy) * this.scale];
  }

  toLngLat(east: number, north: number): LngLat {
    return mercatorToLngLat(this.cx + east / this.scale, this.cy + north / this.scale);
  }
}

/** Ancho/alto aproximados de la caja en metros. */
export function bboxSizeMeters(bbox: BBox): { width: number; height: number } {
  const f = new LocalFrame(bbox);
  const [x0, y0] = f.toLocal(bbox.west, bbox.south);
  const [x1, y1] = f.toLocal(bbox.east, bbox.north);
  return { width: x1 - x0, height: y1 - y0 };
}
