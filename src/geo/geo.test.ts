import { describe, expect, it } from "vitest";
import { LocalFrame, lngLatToMercator, mercatorToLngLat, tileRange } from "./mercator";
import { assembleRings, buildPolygons, clipPolyline, pointInRing, ringCentroid } from "./polygon";
import { sunPosition } from "./sun";

const ll = (lng: number, lat: number) => ({ lng, lat });

describe("mercator", () => {
  it("ida y vuelta lng/lat ↔ Mercator", () => {
    const m = lngLatToMercator(-3.7038, 40.4168);
    const back = mercatorToLngLat(m.x, m.y);
    expect(back.lng).toBeCloseTo(-3.7038, 9);
    expect(back.lat).toBeCloseTo(40.4168, 9);
  });

  it("el marco local mide distancias reales", () => {
    const f = new LocalFrame({ south: 40.41, west: -3.71, north: 40.42, east: -3.7 });
    const [x0, y0] = f.toLocal(-3.705, 40.41);
    const [, y1] = f.toLocal(-3.705, 40.42);
    // 0.01° de latitud ≈ 1111 m
    expect(y1 - y0).toBeGreaterThan(1105);
    expect(y1 - y0).toBeLessThan(1118);
    expect(Math.abs(x0)).toBeLessThan(1e-6);
    const back = f.toLngLat(250, -300);
    const [x, y] = f.toLocal(back.lng, back.lat);
    expect(x).toBeCloseTo(250, 6);
    expect(y).toBeCloseTo(-300, 6);
  });

  it("calcula el rango de teselas", () => {
    const r = tileRange({ south: 40.41, west: -3.71, north: 40.42, east: -3.7 }, 15);
    expect(r.count).toBeGreaterThan(0);
    expect(r.maxX).toBeGreaterThanOrEqual(r.minX);
  });
});

describe("polígonos", () => {
  const square = [ll(0, 0), ll(1, 0), ll(1, 1), ll(0, 1), ll(0, 0)];

  it("punto en anillo y centroide", () => {
    expect(pointInRing(ll(0.5, 0.5), square)).toBe(true);
    expect(pointInRing(ll(1.5, 0.5), square)).toBe(false);
    const c = ringCentroid(square);
    expect(c.lng).toBeCloseTo(0.5);
    expect(c.lat).toBeCloseTo(0.5);
  });

  it("une tramos de multipolígono, incluso invertidos", () => {
    const rings = assembleRings([
      [ll(0, 0), ll(1, 0)],
      [ll(1, 1), ll(1, 0)], // invertido
      [ll(1, 1), ll(0, 1), ll(0, 0)],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
  });

  it("descarta anillos que no cierran y asigna huecos", () => {
    expect(assembleRings([[ll(0, 0), ll(1, 0), ll(1, 1)]])).toHaveLength(0);
    const hole = [ll(0.2, 0.2), ll(0.4, 0.2), ll(0.4, 0.4), ll(0.2, 0.2)];
    const polys = buildPolygons([square], [hole]);
    expect(polys[0].holes).toHaveLength(1);
  });

  it("recorta polilíneas al rectángulo", () => {
    const r = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const runs = clipPolyline(
      [
        [-5, 5],
        [5, 5],
        [15, 5],
        [15, 8],
        [5, 8],
      ],
      r,
    );
    expect(runs).toHaveLength(2);
    expect(runs[0][0]).toEqual([0, 5]);
    expect(runs[0][runs[0].length - 1]).toEqual([10, 5]);
    expect(runs[1]).toEqual([
      [10, 8],
      [5, 8],
    ]);
    expect(clipPolyline([[20, 20], [30, 30]], r)).toHaveLength(0);
  });
});

describe("sol", () => {
  it("al mediodía solar de verano en Madrid el sol está alto y al sur", () => {
    // 21 de junio, ~12:15 UTC es el mediodía solar en -3.7°
    const { azimuth, altitude } = sunPosition(new Date("2026-06-21T12:15:00Z"), 40.4168, -3.7038);
    expect((altitude * 180) / Math.PI).toBeGreaterThan(70);
    expect((azimuth * 180) / Math.PI).toBeGreaterThan(160);
    expect((azimuth * 180) / Math.PI).toBeLessThan(200);
  });

  it("por la mañana el sol está al este", () => {
    const { azimuth } = sunPosition(new Date("2026-03-20T08:00:00Z"), 40.4168, -3.7038);
    const deg = (azimuth * 180) / Math.PI;
    expect(deg).toBeGreaterThan(70);
    expect(deg).toBeLessThan(140);
  });
});
