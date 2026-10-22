import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import { bilinear, type ElevationSampler } from "./terrain";

/**
 * Construye la definición proj4 para los EPSG más habituales en DEMs:
 * geográficas WGS84, Web Mercator y UTM (WGS84 / ETRS89).
 */
export function projForEpsg(code: number): string | null {
  if (code === 4326 || code === 4258) return "+proj=longlat +datum=WGS84 +no_defs";
  if (code === 3857 || code === 900913) return "EPSG:3857";
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (code >= 25828 && code <= 25838) return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +units=m +no_defs`;
  return null;
}

class RasterSampler implements ElevationSampler {
  private readonly toRaster: (lng: number, lat: number) => [number, number];

  constructor(
    readonly label: string,
    private readonly data: ArrayLike<number>,
    private readonly w: number,
    private readonly h: number,
    private readonly origin: [number, number],
    private readonly res: [number, number],
    projDef: string,
    private readonly noData: number | null,
  ) {
    const conv = proj4("EPSG:4326", projDef);
    this.toRaster = (lng, lat) => conv.forward([lng, lat]) as [number, number];
  }

  elevation(lng: number, lat: number): number {
    const [x, y] = this.toRaster(lng, lat);
    const px = (x - this.origin[0]) / this.res[0] - 0.5;
    const py = (y - this.origin[1]) / this.res[1] - 0.5;
    const v = bilinear(this.data, this.w, this.h, px, py);
    if (this.noData !== null && Math.abs(v - this.noData) < 1e-3) return NaN;
    if (v < -1000 || v > 9000) return NaN; // valores de relleno típicos (-32768, -9999…)
    return v;
  }
}

/** Carga un DEM GeoTIFF aportado por el usuario (LiDAR, MDT nacional, dron…). */
export async function loadGeoTiffDem(file: File): Promise<ElevationSampler> {
  const tiff = await fromArrayBuffer(await file.arrayBuffer());
  const image = await tiff.getImage();
  const keys = (image.getGeoKeys?.() ?? {}) as Record<string, number>;
  const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey;
  const def = epsg ? projForEpsg(epsg) : null;
  if (!def) {
    throw new Error(
      `Sistema de referencia no soportado (EPSG ${epsg ?? "desconocido"}). Reproyecta el DEM a EPSG:4326, 3857 o UTM (p. ej. con gdalwarp).`,
    );
  }
  const raster = (await image.readRasters({ samples: [0], interleave: true })) as unknown as ArrayLike<number>;
  const origin = image.getOrigin() as [number, number];
  const res = image.getResolution() as [number, number];
  const nd = image.getGDALNoData();
  return new RasterSampler(`DEM ${file.name}`, raster, image.getWidth(), image.getHeight(), origin, res, def, nd);
}
