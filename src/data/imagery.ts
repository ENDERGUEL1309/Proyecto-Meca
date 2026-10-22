import type { BBox, ProgressFn } from "../types";
import { lngLatToTile, tileRange } from "../geo/mercator";
import { loadBitmap, mapLimit } from "./fetching";

export interface ImagerySource {
  id: string;
  label: string;
  url: string;
  maxZoom: number;
  attribution: string;
}

export const IMAGERY_SOURCES: ImagerySource[] = [
  {
    id: "esri",
    label: "Satélite (Esri World Imagery)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution: "Imagen © Esri, Maxar, Earthstar Geographics y la comunidad GIS",
  },
];

/** Zoom más alto que cabe en `maxPx` píxeles por lado. */
export function imageryZoom(bbox: BBox, maxZoom: number, maxPx: number): number {
  for (let z = maxZoom; z > 0; z--) {
    const nw = lngLatToTile(bbox.west, bbox.north, z);
    const se = lngLatToTile(bbox.east, bbox.south, z);
    if ((se.x - nw.x) * 256 <= maxPx && (se.y - nw.y) * 256 <= maxPx) return z;
  }
  return 1;
}

/**
 * Compone un ortomosaico recortado exactamente a la caja (en proyección Mercator),
 * listo para usarse como textura del terreno.
 */
export async function fetchImagery(
  bbox: BBox,
  source: ImagerySource,
  maxPx: number,
  progress: ProgressFn,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  const z = imageryZoom(bbox, source.maxZoom, maxPx);
  const r = tileRange(bbox, z);
  const nw = lngLatToTile(bbox.west, bbox.north, z);
  const se = lngLatToTile(bbox.east, bbox.south, z);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((se.x - nw.x) * 256));
  canvas.height = Math.max(1, Math.round((se.y - nw.y) * 256));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#888";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const tiles: { x: number; y: number }[] = [];
  for (let y = r.minY; y <= r.maxY; y++) for (let x = r.minX; x <= r.maxX; x++) tiles.push({ x, y });
  let done = 0;
  await mapLimit(tiles, 8, async (t) => {
    const url = source.url.replace("{z}", String(z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
    const bmp = await loadBitmap(url, signal);
    if (bmp) {
      ctx.drawImage(bmp, (t.x - nw.x) * 256, (t.y - nw.y) * 256, 256, 256);
      bmp.close();
    }
    progress(`Imagen satelital: ${++done}/${tiles.length} teselas (zoom ${z})`);
  });
  return canvas;
}
