import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import exifr from "exifr";
import type { LngLat } from "../types";
import type { LocalFrame } from "../geo/mercator";
import type { TerrainSurface } from "./terrainMesh";

/* ---------- Planos / mapeos previos ---------- */

export interface PlanTransform {
  /** Desplazamiento en metros (este, norte) desde el centro de la zona. */
  east: number;
  north: number;
  /** Ancho del plano en metros reales. */
  width: number;
  /** Giro en grados (sentido horario respecto al norte). */
  rotation: number;
  opacity: number;
}

/**
 * Plano o croquis del usuario (imagen) que se "drapea" sobre el relieve.
 * Se coloca con desplazamiento, escala y giro hasta que coincide con la realidad.
 */
export class PlanOverlay {
  readonly mesh: THREE.Mesh;
  readonly aspect: number;

  constructor(
    readonly name: string,
    image: HTMLImageElement | ImageBitmap,
    private readonly surface: TerrainSurface,
    public transform: PlanTransform,
  ) {
    this.aspect = image.height / image.width;
    const tex = new THREE.Texture(image as HTMLImageElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: transform.opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.name = `plano ${name}`;
    this.mesh.renderOrder = 2;
    this.update(transform);
  }

  update(t: PlanTransform) {
    this.transform = t;
    const w = t.width;
    const h = t.width * this.aspect;
    const seg = 96;
    const plane = new THREE.PlaneGeometry(w, h, seg, Math.max(1, Math.round(seg * this.aspect)));
    const pos = plane.attributes.position as THREE.BufferAttribute;
    const rot = (-t.rotation * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    for (let k = 0; k < pos.count; k++) {
      const lx = pos.getX(k);
      const ly = pos.getY(k);
      const east = t.east + lx * cos - ly * sin;
      const north = t.north + lx * sin + ly * cos;
      pos.setXYZ(k, east, this.surface.heightAt(east, north) + 0.6, -north);
    }
    plane.computeVertexNormals();
    this.mesh.geometry.dispose();
    this.mesh.geometry = plane;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = t.opacity;
  }
}

/* ---------- Fotos de campo ---------- */

export interface FieldPhoto {
  file: File;
  url: string;
  position: LngLat | null;
  /** Rumbo de la cámara en grados (EXIF GPSImgDirection), si existe. */
  heading: number | null;
  takenAt: Date | null;
}

export async function readPhoto(file: File): Promise<FieldPhoto> {
  const url = URL.createObjectURL(file);
  let position: LngLat | null = null;
  let heading: number | null = null;
  let takenAt: Date | null = null;
  try {
    const meta = await exifr.parse(file, { gps: true, pick: ["GPSImgDirection", "DateTimeOriginal", "latitude", "longitude"] });
    if (meta && Number.isFinite(meta.latitude) && Number.isFinite(meta.longitude)) {
      position = { lat: meta.latitude, lng: meta.longitude };
    }
    if (meta?.GPSImgDirection !== undefined) heading = Number(meta.GPSImgDirection);
    if (meta?.DateTimeOriginal instanceof Date) takenAt = meta.DateTimeOriginal;
  } catch {
    /* foto sin EXIF: se podrá colocar a mano */
  }
  return { file, url, position, heading, takenAt };
}

/** Marcador 3D de una foto: poste + miniatura orientada al rumbo de la cámara. */
export async function buildPhotoMarker(photo: FieldPhoto, east: number, north: number, surface: TerrainSurface): Promise<THREE.Group> {
  const g = new THREE.Group();
  g.name = `foto ${photo.file.name}`;
  g.userData.photo = photo;
  const ground = surface.heightAt(east, north);
  const scale = Math.max(4, surface.width / 120);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(scale * 0.03, scale * 0.03, scale * 1.2, 6),
    new THREE.MeshBasicMaterial({ color: 0xff5a36 }),
  );
  pole.position.y = scale * 0.6;
  g.add(pole);

  const bmp = await createImageBitmap(photo.file, { resizeWidth: 256, resizeQuality: "medium" });
  const tex = new THREE.Texture(bmp as unknown as HTMLImageElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const aspect = bmp.height / bmp.width;
  let card: THREE.Object3D;
  if (photo.heading !== null) {
    // tarjeta fija mirando en la dirección en que se tomó la foto
    card = new THREE.Mesh(
      new THREE.PlaneGeometry(scale, scale * aspect),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    card.rotation.y = -(photo.heading * Math.PI) / 180; // cara visible hacia quien tomó la foto
  } else {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
    sprite.scale.set(scale, scale * aspect, 1);
    card = sprite;
  }
  card.position.y = scale * 1.2 + (scale * aspect) / 2;
  g.add(card);
  g.position.set(east, ground, -north);
  return g;
}

/* ---------- Modelos 3D importados ---------- */

export interface ModelTransform {
  east: number;
  north: number;
  rotation: number;
  scale: number;
  lift: number;
}

/**
 * Importa un modelo glTF/GLB (fotogrametría con Polycam/RealityScan/Meshroom,
 * BIM exportado, SketchUp, Blender…) y lo apoya sobre el terreno.
 */
export async function loadModel(file: File): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    root.name = `modelo ${file.name}`;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    // pivote en el centro de la base para que "colocar" sea intuitivo
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    const holder = new THREE.Group();
    holder.name = root.name;
    holder.add(root);
    return holder;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function placeModel(obj: THREE.Object3D, t: ModelTransform, surface: TerrainSurface) {
  obj.position.set(t.east, surface.heightAt(t.east, t.north) + t.lift, -t.north);
  obj.rotation.set(0, (-t.rotation * Math.PI) / 180, 0);
  obj.scale.setScalar(t.scale);
  obj.userData.transform = t;
}

export function localFromLngLat(frame: LocalFrame, p: LngLat): [number, number] {
  return frame.toLocal(p.lng, p.lat);
}
