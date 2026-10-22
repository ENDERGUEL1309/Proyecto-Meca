import type * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

/** Exporta el modelo (sin ayudas visuales) a GLB binario con metadatos de georreferencia. */
export async function exportGlb(root: THREE.Object3D, extras: Record<string, unknown>): Promise<Blob> {
  root.userData = { ...root.userData, ...extras };
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible: true, maxTextureSize: 8192 });
  return new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
