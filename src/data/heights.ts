import type { Tags } from "../types";

/** Convierte valores OSM de longitud ("12", "12 m", "12,5", "40'", "10'6\"", "30 ft") a metros. */
export function parseLength(value: string | undefined): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(",", ".");
  const feetInches = v.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (feetInches) return parseFloat(feetInches[1]) * 0.3048 + (feetInches[2] ? parseFloat(feetInches[2]) * 0.0254 : 0);
  const m = v.match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|metros?|ft|feet)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "ft" || m[2] === "feet" ? n * 0.3048 : n;
}

function parseLevels(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseFloat(value.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface HeightOptions {
  /** Altura típica de una planta en metros. */
  levelHeight: number;
  /** Altura usada cuando OSM no aporta ningún dato. */
  defaultHeight: number;
}

export const DEFAULT_HEIGHT_OPTIONS: HeightOptions = { levelHeight: 3, defaultHeight: 6 };

/** Alturas por defecto según el tipo de edificio cuando no hay `height` ni `building:levels`. */
const TYPE_HEIGHTS: Record<string, number> = {
  house: 6,
  detached: 6,
  semidetached_house: 6,
  terrace: 7,
  bungalow: 3.5,
  garage: 3,
  garages: 3,
  shed: 2.5,
  carport: 2.5,
  hut: 2.5,
  roof: 4,
  apartments: 15,
  residential: 9,
  commercial: 10,
  retail: 6,
  office: 15,
  industrial: 8,
  warehouse: 8,
  school: 9,
  hospital: 15,
  church: 15,
  cathedral: 25,
  hotel: 15,
};

export interface BuildingHeight {
  /** Altura de la base sobre el terreno (voladizos, partes elevadas). */
  min: number;
  /** Altura de la cubierta sobre el terreno. */
  max: number;
  /** Indica si la altura proviene de datos reales de OSM o de una estimación. */
  source: "height" | "levels" | "type" | "default";
}

/**
 * Altura según el esquema Simple 3D Buildings: `height` tiene prioridad,
 * luego `building:levels` (+ `roof:levels`) y por último una estimación por tipo.
 */
export function buildingHeight(tags: Tags, opts: HeightOptions = DEFAULT_HEIGHT_OPTIONS): BuildingHeight {
  const lh = opts.levelHeight;
  const height = parseLength(tags.height);
  const levels = parseLevels(tags["building:levels"]);
  const roofLevels = parseLevels(tags["roof:levels"]) ?? 0;
  const roofHeight = parseLength(tags["roof:height"]) ?? 0;
  const minHeight = parseLength(tags.min_height);
  const minLevel = parseLevels(tags["building:min_level"]);
  const min = minHeight ?? (minLevel !== null ? minLevel * lh : 0);

  let max: number;
  let source: BuildingHeight["source"];
  if (height !== null && height > 0) {
    max = height;
    source = "height";
  } else if (levels !== null && levels > 0) {
    max = (levels + roofLevels) * lh + roofHeight;
    source = "levels";
  } else {
    const type = tags.building ?? tags["building:part"];
    const typed = type ? TYPE_HEIGHTS[type] : undefined;
    max = typed ?? opts.defaultHeight;
    source = typed ? "type" : "default";
  }
  if (max <= min) max = min + lh;
  return { min, max, source };
}
