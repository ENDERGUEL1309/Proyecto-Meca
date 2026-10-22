import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";

/**
 * Visor Three.js con renderizado bajo demanda: solo se dibuja cuando algo cambia,
 * lo que mantiene la GPU en reposo mientras el usuario no interactúa.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  readonly hemi = new THREE.HemisphereLight(0xdfe9ff, 0x6b5a45, 1.1);
  /** Contenido exportable (terreno, edificios, vías, modelos del usuario). */
  readonly content = new THREE.Group();
  /** Ayudas visuales que no se exportan (marcadores de fotos, selección). */
  readonly helpers = new THREE.Group();
  private needsRender = true;
  private extent = 1000;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
    this.camera.position.set(600, 600, 600);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener("change", () => this.invalidate());

    this.scene.background = new THREE.Color(0xbfd6ea);
    this.scene.fog = new THREE.Fog(0xbfd6ea, 5000, 20000);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.5;
    this.content.name = "modelo";
    this.scene.add(this.hemi, this.sun, this.sun.target, this.content, this.helpers);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      // el amortiguado necesita unos fotogramas extra tras soltar el ratón
      if (this.controls.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  invalidate() {
    this.needsRender = true;
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Ajusta cámara, niebla y sombra al tamaño de la zona modelada. */
  frame(width: number, depth: number, centerHeight: number) {
    this.extent = Math.max(width, depth);
    const e = this.extent;
    this.camera.near = Math.max(0.5, e / 5000);
    this.camera.far = e * 20;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(e * 0.55, centerHeight + e * 0.6, e * 0.75);
    this.controls.target.set(0, centerHeight, 0);
    this.controls.maxDistance = e * 4;
    this.scene.fog = new THREE.Fog(0xbfd6ea, e * 2, e * 8);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -e * 0.75;
    cam.right = cam.top = e * 0.75;
    cam.near = 1;
    cam.far = e * 4;
    cam.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Coloca el sol según azimut (desde el norte) y altura, en radianes. */
  setSun(azimuth: number, altitude: number) {
    const e = this.extent;
    const r = e * 1.5;
    const alt = Math.max(altitude, 0.02);
    const x = Math.sin(azimuth) * Math.cos(alt) * r;
    const z = -Math.cos(azimuth) * Math.cos(alt) * r; // norte = -z
    const y = Math.sin(alt) * r;
    this.sun.position.set(x, y + this.controls.target.y, z);
    this.sun.target.position.copy(this.controls.target);
    this.sun.intensity = altitude > 0 ? 2.2 * Math.min(1, altitude / 0.3 + 0.2) : 0.15;
    this.invalidate();
  }

  clearContent() {
    const dispose = (o: THREE.Object3D) => {
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
    };
    for (const g of [this.content, this.helpers]) {
      for (const c of [...g.children]) {
        dispose(c);
        g.remove(c);
      }
    }
    this.invalidate();
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }
}
