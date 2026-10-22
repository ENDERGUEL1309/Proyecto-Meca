import { describe, expect, it } from "vitest";
import { clipRing, convexHull, minAreaRect, ringArea } from "./polygon";
import { seededRandom } from "./random";

describe("recorte de anillos", () => {
  it("recorta un cuadrado que sobresale del rectángulo", () => {
    const ring: [number, number][] = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const clipped = clipRing(ring, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(ringArea(clipped)).toBeCloseTo(25);
  });

  it("devuelve vacío si queda fuera", () => {
    expect(clipRing([[20, 20], [30, 20], [30, 30]], { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toHaveLength(0);
  });
});

describe("rectángulo mínimo", () => {
  it("encuentra un rectángulo girado 30°", () => {
    const a = Math.PI / 6;
    const rot = ([x, y]: [number, number]): [number, number] => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
    const pts = ([[0, 0], [20, 0], [20, 8], [0, 8]] as [number, number][]).map(rot);
    const r = minAreaRect(pts)!;
    expect(r.length).toBeCloseTo(20);
    expect(r.width).toBeCloseTo(8);
    expect(Math.abs(r.axis[0] * Math.cos(a) + r.axis[1] * Math.sin(a))).toBeCloseTo(1);
  });

  it("la envolvente descarta puntos interiores", () => {
    expect(convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]])).toHaveLength(4);
  });
});

describe("aleatorio con semilla", () => {
  it("es reproducible", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
