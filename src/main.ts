import * as THREE from "three";
import "./style.css";
import type { BBox, LngLat } from "./types";
import { LocalFrame, bboxSizeMeters } from "./geo/mercator";
import { ringCentroid } from "./geo/polygon";
import { sunPosition } from "./geo/sun";
import { fetchTerrariumGrid, LayeredSampler, type ElevationSampler } from "./data/terrain";
import { loadGeoTiffDem } from "./data/geotiff";
import { fetchImagery, IMAGERY_SOURCES } from "./data/imagery";
import { fetchOsm, type BuildingFeature, type OsmData } from "./data/osm";
import { Viewer } from "./scene/viewer";
import { buildTerrainMesh, sampleSurface, type TerrainSurface } from "./scene/terrainMesh";
import { buildBuildings, flattenUnderBuildings, isSuspiciousBlock, recordForFace, type Footings, type BuildingOptions, type BuildingRecord, type HeightOverride } from "./scene/buildings";
import { buildRoads } from "./scene/roads";
import { buildWater, carveWaterBodies, waterBodies } from "./scene/water";
import { facadeTexture } from "./scene/textures";
import { paintMapTexture } from "./scene/mapTexture";
import {
  PlanOverlay,
  buildPhotoMarker,
  loadModel,
  placeModel,
  readPhoto,
  type FieldPhoto,
  type ModelTransform,
} from "./scene/userContent";
import { download, exportGlb } from "./scene/exporter";
import { MapSelector, describeBBox, escapeHtml } from "./ui/mapSelector";

/** Límites de área: por encima, Overpass y la GPU empiezan a sufrir. */
const WARN_KM2 = 4;
const MAX_KM2 = 16;

const isTouch = window.matchMedia("(pointer: coarse)").matches;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- Estado ---------- */

interface Project {
  bbox: BBox;
  frame: LocalFrame;
  surface: TerrainSurface;
  osm: OsmData | null;
  buildingsMesh: THREE.Mesh | null;
  records: BuildingRecord[];
  terrain: THREE.Group;
  /** Textura del terreno, reutilizada para proyectar la ortofoto en las cubiertas. */
  texture: THREE.Texture | null;
  facade: THREE.Texture | null;
  footings?: Footings;
  /** Edificios a modelar, fijados al generar (antes de explanar el terreno). */
  buildings: BuildingFeature[];
}

let bbox: BBox | null = null;
let userDem: ElevationSampler | null = null;
let project: Project | null = null;
const overrides = new Map<string, HeightOverride>();
const hidden = new Set<string>();
const photos: FieldPhoto[] = [];
let placing: ((east: number, north: number) => void) | null = null;
let abort: AbortController | null = null;

/* ---------- Vistas ---------- */

const selector = new MapSelector($("map"));
const viewer = new Viewer($("three"));
// ?debug expone el visor en la consola para inspeccionar la escena
if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { meca: { viewer } });
const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0xff5a36);
selectionBox.visible = false;

function showView(view: "map" | "three") {
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("map").classList.toggle("active", view === "map");
  $("three").classList.toggle("active", view === "three");
  if (view === "map") selector.invalidateSize();
  viewer.invalidate();
}
document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view as "map" | "three")),
);

function log(msg: string) {
  const el = $("log");
  const lines = el.textContent ? el.textContent.split("\n") : [];
  // las líneas de progreso («Paso: n/m») de un mismo paso se sobrescriben en su sitio
  const key = msg.split(":")[0];
  const existing = /\d+\/\d+/.test(msg) ? lines.findIndex((l) => l.split(":")[0] === key && /\d+\/\d+/.test(l)) : -1;
  if (existing >= 0) lines[existing] = msg;
  else lines.push(msg);
  el.textContent = lines.slice(-40).join("\n");
  el.scrollTop = el.scrollHeight;
}

function hint(msg: string) {
  $("hint").textContent = msg;
}

/* ---------- 1 · Zona ---------- */

selector.onChange = (b) => {
  bbox = b;
  const btn = $<HTMLButtonElement>("generate");
  if (!b) {
    $("area-info").textContent = "Sin zona seleccionada.";
    btn.disabled = true;
    return;
  }
  const { width, height } = bboxSizeMeters(b);
  const km2 = (width * height) / 1e6;
  let text = describeBBox(b);
  if (km2 > MAX_KM2) text += ` — demasiado grande (máx. ${MAX_KM2} km²)`;
  else if (km2 > WARN_KM2) text += " — zona grande: la descarga puede tardar";
  $("area-info").textContent = text;
  btn.disabled = km2 > MAX_KM2;
};

$("draw").addEventListener("click", () => {
  showView("map");
  selector.startDrawing();
  hint(isTouch ? "Arrastra con el dedo sobre el mapa para marcar la zona" : "Arrastra sobre el mapa para marcar la zona");
});
$("use-view").addEventListener("click", () => selector.useView());
$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("search").value.trim();
  if (!q) return;
  showView("map");
  try {
    if (!(await selector.search(q))) hint(`No se encontró «${q}»`);
  } catch {
    hint("La búsqueda no está disponible ahora mismo");
  }
});

/* ---------- 2 · Fuentes ---------- */

$<HTMLInputElement>("dem-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  userDem = null;
  if (!file) return;
  try {
    log(`Leyendo DEM ${file.name}…`);
    userDem = await loadGeoTiffDem(file);
    log(`DEM cargado: ${file.name}`);
  } catch (err) {
    log(`Error en DEM: ${(err as Error).message}`);
  }
});

function buildingOptions(): BuildingOptions {
  return {
    autoRoofs: $<HTMLInputElement>("auto-roofs").checked,
    levelHeight: parseFloat($<HTMLInputElement>("level-h").value) || 3,
    defaultHeight: parseFloat($<HTMLInputElement>("default-h").value) || 6,
  };
}

$("generate").addEventListener("click", () => generate().catch((err) => log(`Error: ${(err as Error).message}`)));

async function generate() {
  if (!bbox) return;
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const btn = $<HTMLButtonElement>("generate");
  btn.disabled = true;
  $("log").textContent = "";
  $("scene-status").hidden = true;
  overrides.clear();
  hidden.clear();
  selectBuilding(null);
  try {
    const area = bbox;
    const frame = new LocalFrame(area);
    const texMode = $<HTMLSelectElement>("texture").value;
    const texSize = parseInt($<HTMLSelectElement>("tex-size").value, 10);
    const wantOsm = $<HTMLInputElement>("with-buildings").checked || $<HTMLInputElement>("with-roads").checked || texMode === "map";

    // las tres descargas son independientes: en paralelo
    const [grid, imagery, osm] = await Promise.all([
      fetchTerrariumGrid(area, log, signal),
      texMode === "esri" ? fetchImagery(area, IMAGERY_SOURCES[0], texSize, log, signal) : Promise.resolve(null),
      wantOsm
        ? fetchOsm(area, log, signal).catch((err) => {
            log(`${(err as Error).message}. Se continúa solo con el terreno.`);
            return null;
          })
        : Promise.resolve(null),
    ]);

    const sampler = userDem ? new LayeredSampler([userDem, grid]) : grid;
    log(`Terreno: muestreando ${sampler.label}…`);
    const surface = sampleSurface(area, frame, sampler);
    log(
      `Terreno: ${surface.cols}×${surface.rows} vértices, celda ${surface.cellSize.toFixed(1)} m, ` +
        `cotas ${surface.baseElevation.toFixed(0)}–${(surface.baseElevation + surface.maxHeight).toFixed(0)} m`,
    );

    let canvas: HTMLCanvasElement | null = imagery;
    if (texMode === "map" && osm) canvas = paintMapTexture(osm, frame, surface, texSize);
    let texture: THREE.Texture | null = null;
    if (canvas) {
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = viewer.renderer.capabilities.getMaxAnisotropy();
      // JPEG en el GLB: la ortofoto pesa ~10 veces menos que en PNG
      texture.userData.mimeType = "image/jpeg";
    }

    // el agua se calcula antes de la malla: el terreno se rebaja bajo cada lámina
    // para que el DEM (ruidoso sobre el agua) nunca la tape
    const wantWater = !!osm && $<HTMLInputElement>("with-water").checked;
    const bodies = wantWater ? waterBodies(osm!.areas, frame, surface) : [];
    carveWaterBodies(surface, bodies);
    const buildings = osm ? buildingsInside(osm, area, frame, surface) : [];
    const footings = $<HTMLInputElement>("with-buildings").checked ? flattenUnderBuildings(buildings, frame, surface) : undefined;

    viewer.clearContent();
    clearUserLists();
    const terrain = buildTerrainMesh(surface, texture);
    viewer.content.add(terrain);
    viewer.helpers.add(selectionBox);

    project = { bbox: area, frame, surface, osm, buildingsMesh: null, records: [], terrain, texture, facade: facadeTexture(), footings, buildings };
    if (osm && $<HTMLInputElement>("with-roads").checked) {
      const roads = buildRoads(osm.roads, osm.railways, frame, surface);
      if (roads) viewer.content.add(roads);
    }
    if (wantWater) {
      const water = buildWater(bodies, osm!.waterways, frame, surface);
      if (water) viewer.content.add(water);
      log(`Agua: ${bodies.length} láminas, ${osm!.waterways.length} cauces`);
    }
    rebuildBuildings();

    viewer.frame(surface.width, surface.depth, surface.minX, surface.maxX, -surface.maxY, -surface.minY, (x, z) =>
      surface.heightAt(x, -z),
    );
    updateSun();
    for (const id of ["user-section", "sun-section", "export-section"]) $(id).classList.remove("disabled");
    showView("three");
    hint(
      isTouch
        ? "1 dedo: mover · 2 dedos: girar y zoom · Toca un edificio para editarlo"
        : "Arrastra: mover · Clic derecho / Ctrl: girar · Rueda: zoom · Clic en un edificio: editar",
    );
    const nBuildings = project.records.length;
    if (!osm && wantOsm) {
      setStatus("No se pudieron cargar edificios ni vías: los servidores de OpenStreetMap no respondieron.", true);
    } else if (osm && $<HTMLInputElement>("with-buildings").checked && !nBuildings) {
      setStatus("OpenStreetMap no tiene edificios mapeados en esta zona.", false);
    } else {
      setStatus(`${nBuildings} edificios · ${osm?.roads.length ?? 0} vías · ${bodies.length} cuerpos de agua`, false);
    }
    log("Listo.");
  } finally {
    btn.disabled = false;
  }
}

/** Resumen visible sobre la vista 3D; en caso de aviso, con botón para reintentar. */
function setStatus(text: string, warn: boolean) {
  const el = $("scene-status");
  el.hidden = false;
  el.className = warn ? "warn" : "";
  el.textContent = text;
  if (warn) {
    const retry = document.createElement("button");
    retry.textContent = "Reintentar";
    retry.addEventListener("click", () => generate().catch((err) => log(`Error: ${(err as Error).message}`)));
    el.appendChild(retry);
  } else {
    // el resumen se retira solo; los avisos se quedan hasta reintentar
    const shown = text;
    setTimeout(() => {
      if (el.textContent === shown) el.hidden = true;
    }, 8000);
  }
}

/* ---------- Edificios ---------- */

/**
 * Edificios a modelar: los que tienen el centro dentro de la zona (evita piezas
 * colgando del borde), sin los polígonos que son manzanas enteras mal mapeadas.
 */
function buildingsInside(osm: OsmData, area: BBox, frame: LocalFrame, surface: TerrainSurface) {
  const kept: BuildingFeature[] = [];
  let skipped = 0;
  for (const b of osm.buildings) {
    const c = ringCentroid(b.polygons[0].outer);
    if (c.lat < area.south || c.lat > area.north || c.lng < area.west || c.lng > area.east) continue;
    if (isSuspiciousBlock(b, frame, surface)) skipped++;
    else kept.push(b);
  }
  if (skipped) log(`Edificios: ${skipped} polígonos omitidos (manzanas enteras mapeadas como un solo edificio, sin altura)`);
  return kept;
}

function rebuildBuildings() {
  if (!project) return;
  if (project.buildingsMesh) {
    viewer.content.remove(project.buildingsMesh);
    project.buildingsMesh.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      for (const mat of [m.material].flat()) (mat as THREE.Material | undefined)?.dispose();
    });
    project.buildingsMesh = null;
  }
  project.records = [];
  if (!project.osm || !$<HTMLInputElement>("with-buildings").checked) return;
  const { frame, surface } = project;
  const inside = project.buildings;
  const textured = $<HTMLInputElement>("building-textures").checked;
  const { mesh, records } = buildBuildings(
    inside,
    frame,
    surface,
    buildingOptions(),
    overrides,
    hidden,
    textured ? project.texture : null,
    textured ? project.facade : null,
    project.footings,
  );
  project.buildingsMesh = mesh;
  project.records = records;
  if (mesh) viewer.content.add(mesh);
  const estimated = records.filter((r) => r.height.source === "default" || r.height.source === "type").length;
  const pitched = records.filter((r) => r.roof !== "flat").length;
  log(`Edificios: ${records.length} modelados (${estimated} con altura estimada, en gris claro; ${pitched} con cubierta inclinada)`);
  viewer.invalidate();
}

for (const id of ["level-h", "default-h", "auto-roofs", "building-textures"]) $(id).addEventListener("change", () => rebuildBuildings());

function selectBuilding(rec: BuildingRecord | null) {
  const section = $("building-section");
  if (!rec || !project?.buildingsMesh) {
    section.hidden = true;
    selectionBox.visible = false;
    viewer.invalidate();
    return;
  }
  section.hidden = false;
  const t = rec.feature.tags;
  const sourceText = { height: "dato real (height)", levels: "por número de plantas", type: "estimada por tipo", default: "estimada (sin datos)" }[
    rec.height.source
  ];
  const osmUrl = `https://www.openstreetmap.org/${rec.feature.id}`;
  $("building-info").innerHTML = `
    <div class="card">
      <div class="title"><span>${escapeHtml(t.name ?? t["addr:street"] ?? rec.feature.id)}</span>
        <a href="${osmUrl}" target="_blank" rel="noopener">ver en OSM</a></div>
      <p class="muted">Altura: ${rec.height.max.toFixed(1)} m — ${sourceText}</p>
      <div class="grid2">
        <label>Altura total (m)<input id="b-max" type="number" step="0.5" value="${rec.height.max.toFixed(1)}"></label>
        <label>Base elevada (m)<input id="b-min" type="number" step="0.5" value="${rec.height.min.toFixed(1)}"></label>
      </div>
      <div class="row"><button id="b-apply">Aplicar</button><button id="b-hide">Ocultar</button></div>
      <div class="tags">${Object.entries(t)
        .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
        .join("<br>")}</div>
    </div>`;
  $("b-apply").addEventListener("click", () => {
    const max = parseFloat($<HTMLInputElement>("b-max").value);
    const min = parseFloat($<HTMLInputElement>("b-min").value);
    overrides.set(rec.feature.id, { max: Number.isFinite(max) ? max : undefined, min: Number.isFinite(min) ? min : undefined });
    const id = rec.feature.id;
    rebuildBuildings();
    selectBuilding(project?.records.find((r) => r.feature.id === id) ?? null);
  });
  $("b-hide").addEventListener("click", () => {
    hidden.add(rec.feature.id);
    rebuildBuildings();
    selectBuilding(null);
  });
  highlight(rec);
}

/** Recuadro alrededor de los triángulos del edificio seleccionado. */
function highlight(rec: BuildingRecord) {
  const mesh = project!.buildingsMesh!;
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const [start, end] of rec.spans) {
    for (let k = start * 3; k <= end * 3 + 2; k++) box.expandByPoint(v.fromBufferAttribute(pos, k));
  }
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(...box.getSize(new THREE.Vector3()).toArray()));
  proxy.position.copy(box.getCenter(new THREE.Vector3()));
  proxy.updateMatrixWorld();
  selectionBox.setFromObject(proxy);
  proxy.geometry.dispose();
  selectionBox.visible = true;
  viewer.invalidate();
}

/* ---------- Interacción en 3D ---------- */

$("cam-home").addEventListener("click", () => viewer.recenter());
$("cam-top").addEventListener("click", () => viewer.topView());
$("cam-in").addEventListener("click", () => viewer.zoom(0.6));
$("cam-out").addEventListener("click", () => viewer.zoom(1.6));

const raycaster = new THREE.Raycaster();
const canvasEl = viewer.renderer.domElement;
let downAt: { x: number; y: number } | null = null;
canvasEl.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }));
canvasEl.addEventListener("pointerup", (e) => {
  if (!downAt || !project || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 4) return; // fue un arrastre de cámara
  const rect = canvasEl.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, viewer.camera);
  const targets: THREE.Object3D[] = [project.terrain];
  if (project.buildingsMesh) targets.push(project.buildingsMesh);
  const hit = raycaster.intersectObjects(targets, true)[0];
  if (!hit) return;
  if (placing) {
    const fn = placing;
    setPlacing(null);
    fn(hit.point.x, -hit.point.z);
    return;
  }
  if (hit.object === project.buildingsMesh && hit.faceIndex !== undefined && hit.faceIndex !== null) {
    selectBuilding(recordForFace(project.records, hit.faceIndex));
  } else {
    selectBuilding(null);
  }
});

function setPlacing(fn: ((east: number, north: number) => void) | null, msg = "Haz clic en el terreno para colocar") {
  placing = fn;
  $("three").classList.toggle("placing", !!fn);
  if (fn) {
    showView("three");
    hint(msg);
  } else hint("");
}

/* ---------- 3 · Aportes del usuario ---------- */

function clearUserLists() {
  for (const id of ["plans", "models", "photos"]) $(id).innerHTML = "";
  photos.length = 0;
  selector.setPhotos([]);
}

function card(title: string, onRemove: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="title"><span title="${escapeHtml(title)}">${escapeHtml(title)}</span><button>✕</button></div>`;
  el.querySelector("button")!.addEventListener("click", () => {
    onRemove();
    el.remove();
    viewer.invalidate();
  });
  return el;
}

function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void) {
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  Object.assign(input, { type: "range", min, max, step, value });
  input.addEventListener("input", () => {
    onInput(parseFloat(input.value));
    viewer.invalidate();
  });
  l.appendChild(input);
  parent.appendChild(l);
  return input;
}

$<HTMLInputElement>("plan-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !project) return;
  const bmp = await createImageBitmap(file);
  const s = project.surface;
  const plan = new PlanOverlay(file.name, bmp, s, { east: 0, north: 0, width: Math.min(s.width, s.depth / (bmp.height / bmp.width)), rotation: 0, opacity: 0.75 });
  viewer.helpers.add(plan.mesh);
  const el = card(file.name, () => viewer.helpers.remove(plan.mesh));
  const half = Math.max(s.width, s.depth) / 2;
  const t = () => plan.transform;
  slider(el, "Este ↔ Oeste", -half, half, 0.5, 0, (v) => plan.update({ ...t(), east: v }));
  slider(el, "Norte ↕ Sur", -half, half, 0.5, 0, (v) => plan.update({ ...t(), north: v }));
  slider(el, "Ancho (m)", 5, half * 4, 0.5, t().width, (v) => plan.update({ ...t(), width: v }));
  slider(el, "Giro (°)", -180, 180, 0.5, 0, (v) => plan.update({ ...t(), rotation: v }));
  slider(el, "Opacidad", 0, 1, 0.05, 0.75, (v) => plan.update({ ...t(), opacity: v }));
  const toggle = document.createElement("label");
  toggle.className = "check";
  toggle.innerHTML = `<input type="checkbox"> Incluir en la exportación`;
  toggle.querySelector("input")!.addEventListener("change", (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    (on ? viewer.content : viewer.helpers).add(plan.mesh);
  });
  el.appendChild(toggle);
  $("plans").appendChild(el);
  showView("three");
  viewer.invalidate();
});

$<HTMLInputElement>("photo-files").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!project) return;
  for (const file of files) {
    const photo = await readPhoto(file);
    photos.push(photo);
    let marker: THREE.Object3D | null = null;
    const el = card(file.name, () => {
      if (marker) viewer.helpers.remove(marker);
      photos.splice(photos.indexOf(photo), 1);
      refreshPhotoMap();
    });
    const info = document.createElement("div");
    info.className = "muted";
    el.appendChild(info);
    const img = document.createElement("img");
    img.src = photo.url;
    el.appendChild(img);
    const place = async (east: number, north: number) => {
      if (marker) viewer.helpers.remove(marker);
      marker = await buildPhotoMarker(photo, east, north, project!.surface);
      viewer.helpers.add(marker);
      photo.position = project!.frame.toLngLat(east, north);
      info.textContent = describePhoto(photo);
      refreshPhotoMap();
      viewer.invalidate();
    };
    const btn = document.createElement("button");
    btn.textContent = "Colocar";
    btn.addEventListener("click", () => setPlacing(place, `Haz clic donde se tomó «${file.name}»`));
    el.appendChild(btn);
    if (photo.position && insideProject(photo.position)) {
      const [east, north] = project.frame.toLocal(photo.position.lng, photo.position.lat);
      await place(east, north);
    } else {
      info.textContent = photo.position ? "GPS fuera de la zona modelada" : "Sin GPS: pulsa «Colocar»";
    }
    $("photos").appendChild(el);
  }
  refreshPhotoMap();
});

function describePhoto(p: FieldPhoto): string {
  const parts = [p.position ? `${p.position.lat.toFixed(5)}, ${p.position.lng.toFixed(5)}` : "sin posición"];
  if (p.heading !== null) parts.push(`rumbo ${p.heading.toFixed(0)}°`);
  if (p.takenAt) parts.push(p.takenAt.toLocaleString("es"));
  return parts.join(" · ");
}

function insideProject(p: LngLat): boolean {
  const b = project!.bbox;
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

function refreshPhotoMap() {
  selector.setPhotos(photos.filter((p) => p.position).map((p) => ({ pos: p.position!, label: p.file.name, url: p.url })));
}

$<HTMLInputElement>("model-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !project) return;
  let obj: THREE.Object3D;
  try {
    obj = await loadModel(file);
  } catch (err) {
    log(`No se pudo cargar ${file.name}: ${(err as Error).message}`);
    return;
  }
  const s = project.surface;
  const t: ModelTransform = { east: 0, north: 0, rotation: 0, scale: 1, lift: 0 };
  placeModel(obj, t, s);
  viewer.content.add(obj);
  const el = card(file.name, () => viewer.content.remove(obj));
  const update = (patch: Partial<ModelTransform>) => {
    Object.assign(t, patch);
    placeModel(obj, t, s);
  };
  const btn = document.createElement("button");
  btn.textContent = "Colocar en el terreno";
  btn.addEventListener("click", () => setPlacing((east, north) => update({ east, north })));
  el.appendChild(btn);
  slider(el, "Giro (°)", -180, 180, 1, 0, (v) => update({ rotation: v }));
  slider(el, "Escala (log)", -3, 3, 0.01, 0, (v) => update({ scale: 10 ** v }));
  slider(el, "Elevación (m)", -20, 20, 0.1, 0, (v) => update({ lift: v }));
  $("models").appendChild(el);
  setPlacing((east, north) => update({ east, north }), `Haz clic donde va «${file.name}»`);
});

/* ---------- 4 · Sol ---------- */

const dateInput = $<HTMLInputElement>("sun-date");
const hourInput = $<HTMLInputElement>("sun-hour");
dateInput.valueAsDate = new Date();
function updateSun() {
  if (!project) return;
  const h = parseFloat(hourInput.value);
  const date = new Date(dateInput.value + "T00:00:00Z");
  date.setUTCMinutes(Math.round(h * 60));
  $("sun-hour-label").textContent = `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const { lat, lng } = project.frame.center;
  const { azimuth, altitude } = sunPosition(date, lat, lng);
  viewer.setSun(azimuth, altitude);
}
hourInput.addEventListener("input", updateSun);
dateInput.addEventListener("change", updateSun);
// valor inicial: primera hora de la tarde solar de la zona visible
selector.map.on("moveend", () => {
  if (project) return;
  const lng = selector.map.getCenter().lng;
  hourInput.value = String(Math.min(23.75, Math.max(0, ((12 - lng / 15) % 24 + 24) % 24 + 2)));
});

/* ---------- 5 · Exportar ---------- */

$("export-glb").addEventListener("click", async () => {
  if (!project) return;
  log("Exportando GLB…");
  const { frame, surface, bbox: area } = project;
  const blob = await exportGlb(viewer.content, {
    georeference: {
      crs: "Local ENU aprox. (Web Mercator escalado), metros. x=este, y=arriba, -z=norte",
      origin: { lat: frame.center.lat, lng: frame.center.lng, elevation: surface.baseElevation },
      bbox: area,
    },
    attribution: $("attribution").textContent?.trim(),
  });
  download(blob, `meca3d_${frame.center.lat.toFixed(4)}_${frame.center.lng.toFixed(4)}.glb`);
  log(`GLB exportado (${(blob.size / 1e6).toFixed(1)} MB)`);
});

$("screenshot").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = viewer.screenshot();
  a.download = "meca3d.png";
  a.click();
});
