import type { BBox, ProgressFn } from "../types";
import { lngLatToMercator, tileMercatorBounds, tileRange } from "../geo/mercator";
import { loadBitmap, mapLimit } from "./fetching";

/** Fuente de elevación consultable en cualquier punto. Devuelve NaN fuera de cobertura. */
export interface ElevationSampler {
  readonly label: string;
  elevation(lng: number, lat: number): number;
}

/** Rejilla regular alineada con Web Mercator (fila 0 = norte). */
export class MercatorGrid implements ElevationSampler {
  constructor(
    readonly label: string,
    readonly width: number,
    readonly height: number,
    readonly data: Float32Array,
    readonly bounds: { minX: number; minY: number; maxX: number; maxY: number },
  ) {}

  elevation(lng: number, lat: number): number {
    const m = lngLatToMercator(lng, lat);
    const { minX, minY, maxX, maxY } = this.bounds;
    // centros de píxel
    const px = ((m.x - minX) / (maxX - minX)) * this.width - 0.5;
    const py = ((maxY - m.y) / (maxY - minY)) * this.height - 0.5;
    return bilinear(this.data, this.width, this.height, px, py);
  }
}

export function bilinear(data: ArrayLike<number>, w: number, h: number, px: number, py: number): number {
  if (px < -0.5 || py < -0.5 || px > w - 0.5 || py > h - 0.5) return NaN;
  const x = Math.min(Math.max(px, 0), w - 1);
  const y = Math.min(Math.max(py, 0), h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Codificación Terrarium (Mapzen / AWS Terrain Tiles). */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRARIUM_MAX_ZOOM = 15;

/** Elige el zoom más alto cuyo mosaico no supere `maxTiles`. */
export function pickZoom(bbox: BBox, maxZoom: number, maxTiles: number): number {
  for (let z = maxZoom; z > 0; z--) {
    if (tileRange(bbox, z).count <= maxTiles) return z;
  }
  return 1;
}

/**
 * Descarga el mosaico de elevación global (AWS Terrain Tiles, sin API key)
 * que cubre la zona. Resolución ~30 m en la mayor parte del mundo, mejor
 * donde existen fuentes nacionales (USGS 3DEP, etc.).
 */
export async function fetchTerrariumGrid(bbox: BBox, progress: ProgressFn, signal?: AbortSignal): Promise<MercatorGrid> {
  const z = pickZoom(bbox, TERRARIUM_MAX_ZOOM, 36);
  const r = tileRange(bbox, z);
  const cols = r.maxX - r.minX + 1;
  const rows = r.maxY - r.minY + 1;
  const W = cols * 256;
  const H = rows * 256;
  const data = new Float32Array(W * H);
  const tiles: { x: number; y: number }[] = [];
  for (let y = r.minY; y <= r.maxY; y++) for (let x = r.minX; x <= r.maxX; x++) tiles.push({ x, y });

  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let done = 0;
  await mapLimit(tiles, 6, async (t) => {
    const url = TERRARIUM_URL.replace("{z}", String(z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
    const bmp = await loadBitmap(url, signal);
    if (!bmp) throw new Error(`No se pudo descargar la tesela de elevación ${z}/${t.x}/${t.y}`);
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, 256, 256).data;
    const ox = (t.x - r.minX) * 256;
    const oy = (t.y - r.minY) * 256;
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const k = (j * 256 + i) * 4;
        data[(oy + j) * W + ox + i] = decodeTerrarium(px[k], px[k + 1], px[k + 2]);
      }
    }
    progress(`Elevación: ${++done}/${tiles.length} teselas (zoom ${z})`);
  });

  const nw = tileMercatorBounds(r.minX, r.minY, z);
  const se = tileMercatorBounds(r.maxX, r.maxY, z);
  return new MercatorGrid(`AWS Terrain Tiles z${z}`, W, H, data, {
    minX: nw.minX,
    maxY: nw.maxY,
    maxX: se.maxX,
    minY: se.minY,
  });
}

/** Usa la primera fuente con dato válido (p. ej. DEM del usuario y, si falta, el global). */
export class LayeredSampler implements ElevationSampler {
  constructor(private readonly layers: ElevationSampler[]) {}

  get label() {
    return this.layers.map((l) => l.label).join(" + ");
  }

  elevation(lng: number, lat: number): number {
    for (const l of this.layers) {
      const v = l.elevation(lng, lat);
      if (Number.isFinite(v)) return v;
    }
    return NaN;
  }
}
