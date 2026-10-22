import type { LocalFrame } from "../geo/mercator";
import type { Ring } from "../types";
import type { OsmData } from "../data/osm";
import { roadStyle } from "./roads";
import type { TerrainSurface } from "./terrainMesh";

/**
 * Textura "cartográfica" generada a partir de los datos vectoriales de OSM:
 * alternativa ligera a la imagen satelital, sin depender de servicios externos.
 */
export function paintMapTexture(osm: OsmData, frame: LocalFrame, surface: TerrainSurface, maxPx = 4096): HTMLCanvasElement {
  const ratio = surface.width / surface.depth;
  const W = ratio >= 1 ? maxPx : Math.round(maxPx * ratio);
  const H = ratio >= 1 ? Math.round(maxPx / ratio) : maxPx;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const sx = W / surface.width;
  const sy = H / surface.depth;
  const px = (lng: number, lat: number): [number, number] => {
    const [x, y] = frame.toLocal(lng, lat);
    return [(x - surface.minX) * sx, (surface.maxY - y) * sy];
  };
  const ringPath = (ring: Ring) => {
    ring.forEach((p, i) => {
      const [x, y] = px(p.lng, p.lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  };

  ctx.fillStyle = "#e9e5d8";
  ctx.fillRect(0, 0, W, H);

  for (const a of osm.areas) {
    ctx.beginPath();
    for (const poly of a.polygons) {
      ringPath(poly.outer);
      poly.holes.forEach(ringPath);
    }
    ctx.fillStyle = a.kind === "water" ? "#9cc3e0" : "#c4d9a6";
    ctx.fill("evenodd");
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const pxPerMeter = (sx + sy) / 2;
  const sorted = [...osm.roads].sort((a, b) => roadStyle(a.tags).width - roadStyle(b.tags).width);
  for (const r of sorted) {
    const s = roadStyle(r.tags);
    ctx.beginPath();
    r.points.forEach((p, i) => {
      const [x, y] = px(p.lng, p.lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineWidth = Math.max(1, s.width * pxPerMeter * 1.4);
    ctx.strokeStyle = "#d6d0c4";
    ctx.stroke();
  }

  ctx.beginPath();
  for (const b of osm.buildings) for (const poly of b.polygons) ringPath(poly.outer);
  ctx.fillStyle = "#cfc6b8";
  ctx.fill();
  return canvas;
}
