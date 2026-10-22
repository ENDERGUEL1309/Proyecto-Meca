import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";

const isTouch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * Visor Three.js con renderizado bajo demanda: solo se dibuja cuando algo cambia,
 * lo que mantiene la GPU en reposo mientras el usuario no interactúa.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.4);
  readonly hemi = new THREE.HemisphereLight(0xdfe9ff, 0x6b5a45, 0.35);
  /** Contenido exportable (terreno, edificios, vías, modelos del usuario). */
  readonly content = new THREE.Group();
  /** Ayudas visuales que no se exportan (marcadores de fotos, selección). */
  readonly helpers = new THREE.Group();
  private readonly sky = new Sky();
  private readonly skyScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envPending = false;
  private needsRender = true;
  private extent = 1000;
  private bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  private ground: ((x: number, z: number) => number) | null = null;
  private home: CameraPose | null = null;
  private flight: { from: CameraPose; to: CameraPose; start: number; duration: number } | null = null;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
    this.camera.position.set(600, 600, 600);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // amortiguado corto: al soltar, la cámara no sigue deslizándose lejos
    this.controls.dampingFactor = 0.14;
    this.controls.zoomToCursor = true;
    this.controls.zoomSpeed = isTouch ? 0.6 : 0.9;
    this.controls.rotateSpeed = isTouch ? 0.6 : 0.8;
    this.controls.minDistance = 15;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.addEventListener("change", () => {
      this.constrain();
      this.invalidate();
    });
    // un gesto del usuario cancela cualquier vuelo de cámara en curso
    this.controls.addEventListener("start", () => (this.flight = null));

    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.5;
    u.rayleigh.value = 1.8;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    u.cloudCoverage.value = 0.35;
    this.skyScene.add(this.sky);

    this.scene.fog = new THREE.Fog(0xc9d6e2, 5000, 20000);
    this.sun.castShadow = true;
    const shadowSize = isTouch ? 2048 : 4096;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.content.name = "modelo";
    this.scene.add(this.hemi, this.sun, this.sun.target, this.content, this.helpers);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      if (this.flight) this.stepFlight(now);
      // el amortiguado necesita unos fotogramas extra tras soltar el ratón
      if (this.controls.update() || this.needsRender) {
        this.needsRender = false;
        this.draw();
      }
    };
    requestAnimationFrame(loop);
  }

  invalidate() {
    this.needsRender = true;
  }

  private draw() {
    // el cielo se dibuja como fondo, siempre centrado en la cámara; vive en
    // skyScene para generar el entorno y no se exporta con el modelo
    this.sky.position.copy(this.camera.position);
    this.scene.add(this.sky);
    this.renderer.render(this.scene, this.camera);
    this.skyScene.add(this.sky);
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /**
   * Mantiene la cámara útil: el punto de giro no sale de la zona, sigue la
   * altura del terreno y la cámara nunca queda por debajo del suelo.
   */
  private constrain() {
    const t = this.controls.target;
    const cam = this.camera.position;
    const delta = new THREE.Vector3();
    if (this.bounds) {
      // el punto de giro no sale de la zona: la vista nunca se queda mirando al vacío
      const pad = 0;
      const b = this.bounds;
      delta.x = THREE.MathUtils.clamp(t.x, b.minX - pad, b.maxX + pad) - t.x;
      delta.z = THREE.MathUtils.clamp(t.z, b.minZ - pad, b.maxZ + pad) - t.z;
    }
    if (this.ground) {
      const g = this.ground(t.x + delta.x, t.z + delta.z);
      if (Number.isFinite(g)) delta.y = g - t.y;
    }
    t.add(delta);
    cam.add(delta);
    if (this.ground) {
      const g = this.ground(cam.x, cam.z);
      if (Number.isFinite(g) && cam.y < g + 4) cam.y = g + 4;
    }
  }

  /** Ajusta cámara, límites, niebla, cielo y sombra al tamaño de la zona modelada. */
  frame(width: number, depth: number, minX: number, maxX: number, minZ: number, maxZ: number, ground: (x: number, z: number) => number) {
    this.extent = Math.max(width, depth);
    const e = this.extent;
    this.bounds = { minX, maxX, minZ, maxZ };
    this.ground = ground;
    this.camera.near = Math.max(0.5, e / 5000);
    this.camera.far = e * 20;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = e * 2.2;
    this.scene.fog = new THREE.Fog(0xc9d6e2, e * 1.5, e * 7);
    this.sky.scale.setScalar(e * 10);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -e * 0.75;
    cam.right = cam.top = e * 0.75;
    cam.near = 1;
    cam.far = e * 4;
    cam.updateProjectionMatrix();
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const gy = ground(cx, cz);
    this.home = {
      target: new THREE.Vector3(cx, gy, cz),
      position: new THREE.Vector3(cx + e * 0.45, gy + e * 0.55, cz + e * 0.7),
    };
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.flight = null;
    this.controls.update();
    this.invalidate();
  }

  /** Vuelve a la vista inicial de la zona. */
  recenter() {
    if (this.home) this.flyTo(this.home);
  }

  /** Vista cenital sobre el centro de la zona, con el norte arriba. */
  topView() {
    if (!this.home) return;
    const t = this.home.target.clone();
    this.flyTo({ target: t, position: t.clone().add(new THREE.Vector3(0, this.extent * 1.05, 0.01)) });
  }

  /** Acerca (factor < 1) o aleja (factor > 1) la cámara respecto al punto de giro. */
  zoom(factor: number) {
    const t = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(t);
    const dist = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.flyTo({ target: t, position: t.clone().add(offset.setLength(dist)) }, 350);
  }

  private flyTo(to: CameraPose, duration = 700) {
    this.flight = {
      from: { position: this.camera.position.clone(), target: this.controls.target.clone() },
      to: { position: to.position.clone(), target: to.target.clone() },
      start: performance.now(),
      duration,
    };
    this.invalidate();
  }

  private stepFlight(now: number) {
    const f = this.flight!;
    const k = Math.min(1, (now - f.start) / f.duration);
    const e = easeInOut(k);
    this.camera.position.lerpVectors(f.from.position, f.to.position, e);
    this.controls.target.lerpVectors(f.from.target, f.to.target, e);
    if (k >= 1) this.flight = null;
    this.invalidate();
  }

  /** Coloca el sol según azimut (desde el norte) y altura, en radianes. */
  setSun(azimuth: number, altitude: number) {
    const e = this.extent;
    const dir = new THREE.Vector3(Math.sin(azimuth) * Math.cos(altitude), Math.sin(altitude), -Math.cos(azimuth) * Math.cos(altitude));
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    const lightDir = dir.clone();
    lightDir.y = Math.max(lightDir.y, 0.03);
    const center = this.home?.target ?? this.controls.target;
    this.sun.position.copy(center).addScaledVector(lightDir.normalize(), e * 1.5);
    this.sun.target.position.copy(center);
    // luz cálida y débil al amanecer/atardecer, blanca a mediodía
    const k = THREE.MathUtils.clamp(altitude / 0.5, 0, 1);
    this.sun.color.setRGB(1, 0.75 + 0.25 * k, 0.55 + 0.45 * k);
    this.sun.intensity = altitude > 0 ? 0.6 + 2.2 * k : 0.05;
    this.hemi.intensity = altitude > 0 ? 0.25 + 0.2 * k : 0.08;
    this.scheduleEnvironment();
    this.invalidate();
  }

  /** Regenera el mapa de entorno (reflejos e iluminación ambiental) a partir del cielo. */
  private scheduleEnvironment() {
    if (this.envPending) return;
    this.envPending = true;
    requestAnimationFrame(() => {
      this.envPending = false;
      this.sky.position.set(0, 0, 0);
      const target = this.pmrem.fromScene(this.skyScene, 0, 1, this.extent * 20);
      this.envTarget?.dispose();
      this.envTarget = target;
      this.scene.environment = target.texture;
      this.scene.environmentIntensity = 0.3;
      this.invalidate();
    });
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
    this.draw();
    return this.renderer.domElement.toDataURL("image/png");
  }
}
