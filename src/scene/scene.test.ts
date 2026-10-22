import { describe, expect, it } from "vitest";
import { flattenUnderBuildings, isSuspiciousBlock, planRoof } from "./buildings";
import { LocalFrame } from "../geo/mercator";
import { carveWaterBodies, waterLevel } from "./water";
import { TerrainSurface } from "./terrainMesh";
import { bicubic } from "../data/terrain";

const opts = { levelHeight: 3, defaultHeight: 6, autoRoofs: false };
const rect: [number, number][] = [[0, 0], [12, 0], [12, 8], [0, 8]];

describe("cubiertas", () => {
  it("usa roof:shape y calcula la altura de cubierta", () => {
    const r = planRoof({ building: "house", "roof:shape": "gabled" }, rect, "type", opts);
    expect(r.type).toBe("gabled");
    expect(r.height).toBeCloseTo(8 * 0.35);
    expect(r.included).toBe(false);
  });

  it("respeta roof:height dentro de la altura total", () => {
    const r = planRoof({ building: "house", "roof:shape": "hipped", "roof:height": "3" }, rect, "height", opts);
    expect(r).toMatchObject({ type: "hipped", height: 3, included: true });
  });

  it("solo infiere cubiertas en casas cuando se activa la opción", () => {
    expect(planRoof({ building: "house" }, rect, "type", opts).type).toBe("flat");
    expect(planRoof({ building: "house" }, rect, "type", { ...opts, autoRoofs: true }).type).toBe("hipped");
    expect(planRoof({ building: "office" }, rect, "type", { ...opts, autoRoofs: true }).type).toBe("flat");
  });

  it("no pone faldones en plantas en L", () => {
    const L: [number, number][] = [[0, 0], [12, 0], [12, 3], [3, 3], [3, 12], [0, 12]];
    expect(planRoof({ building: "house", "roof:shape": "gabled" }, L, "type", opts).type).toBe("flat");
  });
});

describe("agua", () => {
  it("rebaja el terreno solo dentro de la lámina", () => {
    // rejilla 11×11 de 0 a 100 m, plana a 5 m
    const s = new TerrainSurface(0, 0, 100, 100, 11, 11, new Float32Array(121).fill(5), 0, 0, 5);
    carveWaterBodies(s, [{ outer: [[30, 30], [70, 30], [70, 70], [30, 70]], holes: [], level: 4 }]);
    expect(s.heightAt(50, 50)).toBeCloseTo(2.5);
    expect(s.heightAt(10, 10)).toBe(5);
  });

  it("toma un percentil bajo de la orilla como nivel del agua", () => {
    expect(waterLevel([10, 10.2, 10.1, 15, 30, 10.3, 10, 12, 11, 10.4])).toBeCloseTo(10.1);
  });
});

describe("interpolación bicúbica", () => {
  it("reproduce los valores en los nodos y es suave entre ellos", () => {
    const d = [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6];
    expect(bicubic(d, 4, 4, 1, 1)).toBeCloseTo(2);
    expect(bicubic(d, 4, 4, 1.5, 1.5)).toBeCloseTo(3); // plano inclinado: exacto
  });
});

describe("asiento de edificios", () => {
  const bbox = { south: -0.001, west: -0.001, north: 0.001, east: 0.001 };
  const frame = new LocalFrame(bbox);
  const [minX, minY] = frame.toLocal(bbox.west, bbox.south);
  const [maxX, maxY] = frame.toLocal(bbox.east, bbox.north);
  const n = 45;
  const slope = () => {
    // ladera: sube 0,5 m por metro hacia el este
    const h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = (i / (n - 1)) * (maxX - minX) * 0.5;
    return new TerrainSurface(minX, minY, maxX, maxY, n, n, h, 0, 0, 100);
  };
  const house = (size: number) => ({
    id: "way/1",
    tags: { building: "yes" },
    polygons: [{ outer: [[-size, -size], [size, -size], [size, size], [-size, size], [-size, -size]].map(([x, y]) => frame.toLngLat(x, y)), holes: [] }],
    isPart: false,
  });

  it("excava como mucho 4 m y no toca el terreno lejano", () => {
    const s = slope();
    const far = s.heightAt(80, 80);
    const before = s.heightAt(10, 0);
    flattenUnderBuildings([house(10)], frame, s);
    expect(s.heightAt(10, 0)).toBeGreaterThanOrEqual(before - 4 - 1e-3);
    expect(s.heightAt(10, 0)).toBeLessThan(before);
    expect(s.heightAt(80, 80)).toBeCloseTo(far);
  });

  it("eleva la cubierta por encima de lo que sobresale en pendiente", () => {
    const s = slope();
    const footings = flattenUnderBuildings([house(10)], frame, s);
    const f = footings.get("way/1#0")!;
    // en 20 m de ancho la ladera sube 10 m: más que la excavación permitida
    expect(f.minTop).toBeGreaterThan(s.heightAt(10, 0));
    expect(f.ground).toBeLessThan(s.heightAt(10, 0));
  });

  it("detecta manzanas enteras mapeadas como un solo edificio", () => {
    const big = { ...house(100), id: "way/2" }; // 200 × 200 m
    expect(isSuspiciousBlock(big, frame)).toBe(true);
    expect(isSuspiciousBlock({ ...big, tags: { building: "yes", "building:levels": "2" } }, frame)).toBe(false);
    expect(isSuspiciousBlock(house(10), frame)).toBe(false);
  });

  it("detecta manzanas en ladera por el desnivel bajo la planta", () => {
    const mid = { ...house(30), id: "way/3" }; // 60 × 60 m sobre una ladera de 30 m de desnivel
    expect(isSuspiciousBlock(mid, frame)).toBe(false);
    expect(isSuspiciousBlock(mid, frame, slope())).toBe(true);
  });

  it("ignora un valor anómalo aislado al estimar el suelo", () => {
    const s = slope();
    const k = Math.floor(n / 2) * n + Math.floor(n / 2);
    s.heights[k] = -400;
    const f = flattenUnderBuildings([house(10)], frame, s).get("way/1#0")!;
    expect(f.ground).toBeGreaterThan(-50);
  });
});

describe("limpieza del DEM", () => {
  it("acota batimetrías absurdas y elimina picos aislados", async () => {
    const { cleanElevations } = await import("./terrainMesh");
    const n = 5;
    const h = new Float32Array(n * n).fill(10);
    h[12] = 300; // pico
    h[0] = -424; // batimetría errónea
    cleanElevations(h, n, n);
    expect(h[12]).toBe(10);
    expect(h[0]).toBeGreaterThanOrEqual(-25);
  });
});
