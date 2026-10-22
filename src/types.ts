export interface LngLat {
  lng: number;
  lat: number;
}

/** Caja geográfica en grados WGS84. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type Ring = LngLat[];

/** Polígono con anillo exterior y huecos (patios, etc.). */
export interface Polygon {
  outer: Ring;
  holes: Ring[];
}

export type Tags = Record<string, string>;

export type ProgressFn = (msg: string) => void;
