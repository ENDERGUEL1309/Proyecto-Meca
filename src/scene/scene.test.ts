import { describe, expect, it } from "vitest";
import { planRoof } from "./buildings";
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
