import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { BBox, LngLat } from "../types";
import { bboxSizeMeters } from "../geo/mercator";

/** Mapa 2D para buscar un lugar y marcar el rectángulo a modelar. */
export class MapSelector {
  readonly map: L.Map;
  private rect: L.Rectangle | null = null;
  private drawing = false;
  private start: L.LatLng | null = null;
  private photoLayer = L.layerGroup();
  onChange: (bbox: BBox | null) => void = () => {};

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: true }).setView([-2.17, -79.9224], 13); // Guayaquil
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Imagen &copy; Esri, Maxar, Earthstar Geographics",
    });
    const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: "&copy; OpenTopoMap (CC-BY-SA)",
    });
    osm.addTo(this.map);
    L.control.layers({ Mapa: osm, "Satélite": sat, "Topográfico": topo }).addTo(this.map);
    this.photoLayer.addTo(this.map);

    this.map.on("mousedown", (e: L.LeafletMouseEvent) => {
      if (!this.drawing) return;
      this.start = e.latlng;
      this.setRect(L.latLngBounds(e.latlng, e.latlng));
    });
    this.map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (this.drawing && this.start) this.setRect(L.latLngBounds(this.start, e.latlng));
    });
    this.map.on("mouseup", () => {
      if (!this.drawing || !this.start) return;
      this.stopDrawing();
      this.emit();
    });
  }

  startDrawing() {
    this.drawing = true;
    this.start = null;
    this.map.dragging.disable();
    this.map.getContainer().classList.add("drawing");
  }

  private stopDrawing() {
    this.drawing = false;
    this.start = null;
    this.map.dragging.enable();
    this.map.getContainer().classList.remove("drawing");
  }

  /** Selecciona la vista actual del mapa (con un pequeño margen). */
  useView() {
    this.setRect(this.map.getBounds().pad(-0.15));
    this.emit();
  }

  private setRect(b: L.LatLngBounds) {
    if (this.rect) this.rect.setBounds(b);
    else this.rect = L.rectangle(b, { color: "#ff5a36", weight: 2, fillOpacity: 0.12 }).addTo(this.map);
  }

  private emit() {
    this.onChange(this.bbox());
  }

  bbox(): BBox | null {
    if (!this.rect) return null;
    const b = this.rect.getBounds();
    if (b.getNorth() === b.getSouth() || b.getEast() === b.getWest()) return null;
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  setPhotos(points: { pos: LngLat; label: string; url: string }[]) {
    this.photoLayer.clearLayers();
    for (const p of points) {
      L.circleMarker([p.pos.lat, p.pos.lng], { radius: 6, color: "#ff5a36", fillOpacity: 0.9 })
        .bindPopup(`<b>${escapeHtml(p.label)}</b><br><img src="${p.url}" style="width:180px">`)
        .addTo(this.photoLayer);
    }
  }

  /** Búsqueda de lugares con Nominatim (geocodificador de OpenStreetMap). */
  async search(query: string): Promise<boolean> {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "es" } });
    const list = (await res.json()) as { lat: string; lon: string; boundingbox: string[] }[];
    if (!list.length) return false;
    const [s, n, w, e] = list[0].boundingbox.map(Number);
    this.map.fitBounds([
      [s, w],
      [n, e],
    ], { maxZoom: 17 });
    return true;
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}

export function describeBBox(b: BBox): string {
  const { width, height } = bboxSizeMeters(b);
  const km2 = (width * height) / 1e6;
  return `${Math.round(width)} × ${Math.round(height)} m (${km2.toFixed(2)} km²)`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
