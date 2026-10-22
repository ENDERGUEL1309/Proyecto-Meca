import { describe, expect, it } from "vitest";
import { buildingHeight, parseLength } from "./heights";
import { parseOverpass } from "./osm";
import { bilinear, decodeTerrarium } from "./terrain";
import { projForEpsg } from "./geotiff";

describe("alturas", () => {
  it("interpreta longitudes OSM", () => {
    expect(parseLength("12")).toBe(12);
    expect(parseLength("12.5 m")).toBe(12.5);
    expect(parseLength("12,5")).toBe(12.5);
    expect(parseLength("30 ft")).toBeCloseTo(9.144);
    expect(parseLength("10'6\"")).toBeCloseTo(3.2004);
    expect(parseLength("alto")).toBeNull();
  });

  it("height tiene prioridad sobre building:levels", () => {
    expect(buildingHeight({ building: "yes", height: "21", "building:levels": "5" })).toMatchObject({ max: 21, source: "height" });
  });

  it("usa plantas, plantas de cubierta y min_level", () => {
    const h = buildingHeight({ "building:part": "yes", "building:levels": "4", "roof:levels": "1", "building:min_level": "2" });
    expect(h).toMatchObject({ min: 6, max: 15, source: "levels" });
  });

  it("estima por tipo o por defecto", () => {
    expect(buildingHeight({ building: "garage" }).source).toBe("type");
    expect(buildingHeight({ building: "yes" }, { levelHeight: 3, defaultHeight: 7 })).toMatchObject({ max: 7, source: "default" });
  });
});

describe("Overpass", () => {
  const g = (pts: [number, number][]) => pts.map(([lon, lat]) => ({ lon, lat }));
  const square = g([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ]);

  it("separa edificios, vías y áreas, y arma multipolígonos", () => {
    const data = parseOverpass({
      elements: [
        { type: "way", id: 1, tags: { building: "yes" }, geometry: square },
        {
          type: "relation",
          id: 2,
          tags: { building: "yes", type: "multipolygon" },
          members: [
            { type: "way", role: "outer", geometry: g([[2, 0], [3, 0], [3, 1]]) },
            { type: "way", role: "outer", geometry: g([[3, 1], [2, 1], [2, 0]]) },
            { type: "way", role: "inner", geometry: g([[2.2, 0.2], [2.4, 0.2], [2.4, 0.4], [2.2, 0.2]]) },
          ],
        },
        { type: "way", id: 3, tags: { highway: "residential" }, geometry: g([[0, 2], [1, 2]]) },
        { type: "way", id: 4, tags: { natural: "water" }, geometry: square },
      ],
    });
    expect(data.buildings.map((b) => b.id)).toEqual(["way/1", "relation/2"]);
    expect(data.buildings[1].polygons[0].holes).toHaveLength(1);
    expect(data.roads).toHaveLength(1);
    expect(data.areas[0].kind).toBe("water");
  });

  it("omite el contorno cuando el edificio tiene building:part", () => {
    const inner = g([
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
      [0.2, 0.2],
    ]);
    const data = parseOverpass({
      elements: [
        { type: "way", id: 1, tags: { building: "yes" }, geometry: square },
        { type: "way", id: 2, tags: { "building:part": "yes", "building:levels": "10" }, geometry: inner },
      ],
    });
    expect(data.buildings.map((b) => b.id)).toEqual(["way/2"]);
  });
});

describe("terreno", () => {
  it("decodifica Terrarium", () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(130, 100, 128)).toBeCloseTo(612.5);
  });

  it("interpola bilinealmente y marca fuera de rango", () => {
    const d = [0, 10, 20, 30];
    expect(bilinear(d, 2, 2, 0.5, 0.5)).toBeCloseTo(15);
    expect(Number.isNaN(bilinear(d, 2, 2, 5, 0))).toBe(true);
  });

  it("reconoce EPSG de DEM habituales", () => {
    expect(projForEpsg(32630)).toContain("+zone=30");
    expect(projForEpsg(32719)).toContain("+south");
    expect(projForEpsg(25830)).toContain("+zone=30");
    expect(projForEpsg(2154)).toBeNull();
  });
});
