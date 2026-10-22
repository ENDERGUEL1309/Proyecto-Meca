import * as THREE from "three";
import { seededRandom } from "../geo/random";

/* Texturas procedurales: se generan en el navegador, sin descargar recursos. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const rnd = seededRandom(seed);
  for (let k = 0; k < img.data.length; k += 4) {
    const n = (rnd() - 0.5) * amount;
    img.data[k] += n;
    img.data[k + 1] += n;
    img.data[k + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Un módulo de fachada = una ventana: 3,5 m de ancho × una planta de alto.
 * Se repite con UV en metros, de modo que las ventanas coinciden con las plantas.
 */
export function facadeTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = "#f2efe9";
  ctx.fillRect(0, 0, 128, 128);
  // forjado entre plantas
  ctx.fillStyle = "#d9d4cb";
  ctx.fillRect(0, 118, 128, 10);
  // ventana con marco y degradado de reflejo
  ctx.fillStyle = "#6b6f73";
  ctx.fillRect(24, 26, 80, 68);
  const g = ctx.createLinearGradient(0, 30, 0, 90);
  g.addColorStop(0, "#9fb4c4");
  g.addColorStop(0.45, "#5c7282");
  g.addColorStop(1, "#3c4a55");
  ctx.fillStyle = g;
  ctx.fillRect(28, 30, 72, 60);
  ctx.fillStyle = "#6b6f73";
  ctx.fillRect(62, 30, 4, 60);
  // alféizar
  ctx.fillStyle = "#c9c3b8";
  ctx.fillRect(20, 94, 88, 5);
  noise(ctx, 128, 128, 10, 7);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Filas del atlas de vías (de arriba abajo). */
export const ROAD_ROWS = ["major", "minor", "path", "track", "rail", "water"] as const;
export type RoadRow = (typeof ROAD_ROWS)[number];
/** Longitud en metros que cubre el ancho del atlas antes de repetirse. */
export const ROAD_TILE_METERS = 8;

/**
 * Atlas de superficies lineales: asfalto con señalización (línea central amarilla
 * discontinua y bordes blancos), calle secundaria, aceras, tierra, vía férrea y agua.
 */
export function roadAtlas(): THREE.CanvasTexture {
  const W = 256;
  const R = 64;
  const [c, ctx] = canvas(W, R * ROAD_ROWS.length);
  const row = (name: RoadRow) => ROAD_ROWS.indexOf(name) * R;
  const fill = (name: RoadRow, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, row(name), W, R);
  };
  fill("major", "#3b3d40");
  fill("minor", "#4a4c4f");
  fill("path", "#b9b2a5");
  fill("track", "#8c7656");
  fill("rail", "#6d665e");
  fill("water", "#3d6b84");
  noise(ctx, W, c.height, 18, 3);

  let y = row("major");
  ctx.fillStyle = "#e8e6df";
  ctx.fillRect(0, y + 6, W, 3);
  ctx.fillRect(0, y + R - 9, W, 3);
  ctx.fillStyle = "#e0b43c";
  ctx.fillRect(0, y + R / 2 - 2, W * 0.45, 4); // 3,6 m de trazo cada 8 m
  y = row("minor");
  ctx.fillStyle = "rgba(230,228,220,0.55)";
  ctx.fillRect(0, y + R / 2 - 1, W * 0.3, 2);
  y = row("path");
  ctx.strokeStyle = "rgba(90,80,70,0.25)";
  for (let x = 0; x < W; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + R);
    ctx.stroke();
  }
  y = row("rail");
  ctx.fillStyle = "#4a3a2c";
  for (let x = 4; x < W; x += 20) ctx.fillRect(x, y + 10, 8, R - 20); // traviesas
  ctx.fillStyle = "#b8bcc0";
  ctx.fillRect(0, y + 20, W, 3);
  ctx.fillRect(0, y + R - 23, W, 3);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Rango v [abajo, arriba] de una fila del atlas, con margen para evitar sangrado. */
export function roadRowV(name: RoadRow): [number, number] {
  const n = ROAD_ROWS.length;
  const i = ROAD_ROWS.indexOf(name);
  const pad = 0.08 / n;
  return [1 - (i + 1) / n + pad, 1 - i / n - pad];
}

/** Mapa de normales de oleaje, periódico para repetirse sin costuras. */
export function waterNormalTexture(): THREE.CanvasTexture {
  const N = 256;
  const [c, ctx] = canvas(N, N);
  const img = ctx.createImageData(N, N);
  const rnd = seededRandom(11);
  const waves = Array.from({ length: 9 }, () => ({
    fx: Math.round(rnd() * 8 - 4) || 1,
    fy: Math.round(rnd() * 8 - 4),
    ph: rnd() * Math.PI * 2,
    amp: 0.4 + rnd(),
  }));
  const h = (x: number, y: number) =>
    waves.reduce((s, w) => s + w.amp * Math.sin(((w.fx * x + w.fy * y) / N) * Math.PI * 2 + w.ph), 0);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = h(x + 1, y) - h(x - 1, y);
      const dy = h(x, y + 1) - h(x, y - 1);
      const nx = -dx * 2;
      const ny = -dy * 2;
      const len = Math.hypot(nx, ny, 1);
      const k = (y * N + x) * 4;
      img.data[k] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[k + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[k + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
