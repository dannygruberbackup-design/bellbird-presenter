import {
  createChromaKeyMaterial,
  setNoColorConversion,
  applyKeyColor,
  keyLuma,
  DEFAULT_CHROMA,
  type ChromaKeyOptions,
} from './chroma-key-material';
import { ensureCameraSource, type CameraSource } from './camera-source';
import { diag } from './diagnostics';
import { RAW_TEXTURE } from './config';

export const PRESENTER_COMPONENT = 'chromaPresenter';

export type PresenterInputs = ChromaKeyOptions & {

  id: string;

  src: string;

  captionsSrc?: string;

  heightMeters: number;

  aspect: number;
  billboard: boolean;

  billboardMode: 'yaw' | 'full';

  startAt: number;

  // Fractions of the source frame trimmed off each edge.
  //
  // Generated footage frames the subject in a wide 16:9 plate with a lot of
  // empty screen either side. Left uncropped that emptiness is still part of
  // the plane, so it is still a tap target: reaching past her to walk on lands
  // on invisible video and restarts the clip instead of moving you. Cropping
  // removes it from the geometry, not just from view.
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;

  // Vertical nudge from the floor, in metres. Kept separate from position so a
  // summon can recompute the floor without discarding a hand-tuned offset.
  groundOffset: number;

  // 'always' keeps her standing there. 'onApproach' hides her behind a marker
  // until a visitor comes within the trigger radius, which is what makes a room
  // full of stations feel like a room rather than a crowd.
  mode: 'always' | 'onApproach';
  /** How close a visitor must be before she appears, in metres. */
  triggerRadius: number;

  /** Show a floating marker when she is not speaking. */
  shadowDiameter: number;

  shadowOpacity: number;
  visible: boolean;
  loop: boolean;
};

export const DEFAULT_PRESENTER: PresenterInputs = {
  ...DEFAULT_CHROMA,
  id: 'presenter',
  src: '',
  heightMeters: 2.0,
  aspect: 9 / 16,
  billboard: true,
  billboardMode: 'yaw',
  startAt: 0,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  groundOffset: 0,
  mode: 'always',
  triggerRadius: 2.5,
  shadowDiameter: 1.65,
  shadowOpacity: 0.55,
  visible: true,
  loop: false,
};

function mediaHost(): HTMLElement {
  let host = document.getElementById('presenter-media-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'presenter-media-host';
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    document.body.appendChild(host);
  }
  return host;
}

function makeShadowTexture(THREE: any): any {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  );
  // The gradient carries its own falloff and the Depth control scales it, so
  // the two multiply: a peak of 0.45 at 30% depth was 13% opacity, which is
  // invisible on a pale tiled floor. Peaking at full black lets Depth mean what
  // it says - 30% is 30% - and keeps the whole range useful.
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(0.4, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(0.75, 'rgba(0,0,0,0.15)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export class ChromaPresenterComponent {
  inputs: PresenterInputs = { ...DEFAULT_PRESENTER };

  outputs: { objectRoot: any; collider: any } = {} as {
    objectRoot: any;
    collider: any;
  };

  events = {
    'INTERACTION.CLICK': true,
  };

  context!: any;
  notify!: (event: string, payload?: unknown) => void;

  video!: HTMLVideoElement;

  private root: any;
  private plane: any;
  private hit: any;
  private shadow: any;
  private material: any;
  private texture: any;
  private camera: CameraSource | null = null;

  private useTestPattern = false;
  private loaded = false;
  private tmpWorldPos: any;
  private tmpCamPos: any;
  private tmpParentQuat: any;
  private tmpEuler: any;

  onClick: (() => void) | null = null;

  onSourceChanged: ((info: string) => void) | null = null;

  onInit() {
    try {
      this.build();
    } catch (error) {

      diag.error(`Presenter onInit failed: ${String(error)}`);
      throw error;
    }
  }

  private build() {
    const THREE = this.context.three;

    this.root = new THREE.Object3D();
    this.tmpWorldPos = new THREE.Vector3();
    this.tmpCamPos = new THREE.Vector3();
    this.tmpParentQuat = new THREE.Quaternion();
    this.tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

    this.camera = ensureCameraSource(THREE, this.context);

    this.useTestPattern = !this.inputs.src || this.inputs.src === 'test';

    this.video = document.createElement('video');
    this.video.crossOrigin = 'anonymous';
    this.video.loop = this.inputs.loop;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');

    this.video.preload = 'none';

    if (!this.useTestPattern) this.video.src = this.inputs.src;

    if (this.inputs.captionsSrc) {
      const track = document.createElement('track');
      track.kind = 'captions';
      track.srclang = 'en';
      track.label = 'English';
      track.src = this.inputs.captionsSrc;
      track.default = true;
      this.video.appendChild(track);
    }

    mediaHost().appendChild(this.video);

    if (this.useTestPattern) {
      // Nothing to show. The stand-in figure earned its place before any
      // footage existed; a cartoon standing in the showroom is now worse than
      // an empty spot, so an unfilled slot renders nothing at all.
      this.texture = new THREE.CanvasTexture(document.createElement('canvas'));

    } else {
      this.texture = new THREE.VideoTexture(this.video);
    }
    // Mipmaps, and they are the point rather than a refinement.
    //
    // She is drawn far smaller than her source: a 1080-tall clip filling maybe
    // 350 pixels of screen is a threefold reduction, and sampling one texel per
    // pixel from a picture three times too big is exactly how detail turns to
    // mush. It is the same softness you get scaling a photo down in a browser
    // rather than in an image editor.
    //
    // three leaves these off for video because regenerating them every frame
    // costs something. For one clip at a time that cost is worth paying, and
    // anisotropic filtering does nothing without them - the two only work as a
    // pair, which is why the previous change alone did not help.
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 8;
    setNoColorConversion(THREE, this.texture);

    this.material = RAW_TEXTURE
      ? new THREE.MeshBasicMaterial({ map: this.texture, side: THREE.DoubleSide, toneMapped: false })
      : createChromaKeyMaterial(THREE, this.texture, this.inputs);
    if (RAW_TEXTURE) diag.warn('Raw texture mode: chroma key bypassed.');

    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.plane.renderOrder = 10;
    this.root.add(this.plane);
    this.resizePlane();

    const shadowMat = new THREE.MeshBasicMaterial({
      map: makeShadowTexture(THREE),
      transparent: true,
      opacity: this.inputs.shadowOpacity,
      depthWrite: false,
      toneMapped: false,
      // The scanned floor is a mesh, not a mathematical plane: it undulates by
      // a centimetre or two. A shadow laid flat a hair above it will be below
      // it somewhere, and there it simply vanishes. The polygon offset biases
      // it towards the camera in depth without moving it in space, so it stays
      // on the floor rather than hovering to stay visible.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.shadow.renderOrder = 9;
    this.root.add(this.shadow);
    this.applyShadow();


    // A dedicated hit target, resized to whatever is currently on show. The
    // video plane cannot do this job: at 16:9 it is a metre of invisible screen
    // either side of her, and every tap meant for the floor beyond lands on it.
    this.hit = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.root.add(this.hit);

    this.applyMode();

    this.root.visible = this.inputs.visible;
    this.outputs.objectRoot = this.root;
    this.outputs.collider = this.hit;


    diag.info(`${this.inputs.id}: built (${this.useTestPattern ? 'stand-in' : 'video'}).`);
  }

  onEvent(eventType: string) {
    if (eventType === 'INTERACTION.CLICK') this.onClick?.();
  }

  useVideo(url: string, label = 'video'): void {
    const THREE = this.context.three;

    this.useTestPattern = false;
    this.loaded = true;

    this.video.src = url;
    this.video.preload = 'auto';
    this.video.loop = this.inputs.loop;

    this.texture?.dispose();
    this.texture = new THREE.VideoTexture(this.video);
    // Mipmaps, and they are the point rather than a refinement.
    //
    // She is drawn far smaller than her source: a 1080-tall clip filling maybe
    // 350 pixels of screen is a threefold reduction, and sampling one texel per
    // pixel from a picture three times too big is exactly how detail turns to
    // mush. It is the same softness you get scaling a photo down in a browser
    // rather than in an image editor.
    //
    // three leaves these off for video because regenerating them every frame
    // costs something. For one clip at a time that cost is worth paying, and
    // anisotropic filtering does nothing without them - the two only work as a
    // pair, which is why the previous change alone did not help.
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 8;
    setNoColorConversion(THREE, this.texture);

    if (this.material.uniforms) this.material.uniforms.uMap.value = this.texture;
    else this.material.map = this.texture;
    this.material.needsUpdate = true;

    const onMeta = () => {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (vw && vh) {
        this.inputs.aspect = vw / vh;
        this.resizePlane();
        diag.info(`${label}: ${vw}x${vh}, aspect ${(vw / vh).toFixed(3)}, ${this.video.duration.toFixed(1)}s`);
        this.onSourceChanged?.(`${vw}x${vh}`);
      }

      this.rewind();
      this.video.removeEventListener('loadedmetadata', onMeta);
    };
    this.video.addEventListener('loadedmetadata', onMeta);
    this.video.load();
  }

  // `heightMeters` is the height of the KEPT window, so once the crop matches
  // the subject's own bounding box it is simply how tall she is.
  private resizePlane(): void {
    const THREE = this.context.three;
    const i = this.inputs;

    const keptW = Math.max(0.05, 1 - i.cropLeft - i.cropRight);
    const keptH = Math.max(0.05, 1 - i.cropTop - i.cropBottom);
    const width = i.heightMeters * ((i.aspect * keptW) / keptH);

    this.plane.geometry.dispose();
    this.plane.geometry = new THREE.PlaneGeometry(width, i.heightMeters);
    this.plane.position.y = i.heightMeters / 2 + i.groundOffset;
    this.applyMode();

    if (this.material?.uniforms?.uCrop) {
      this.material.uniforms.uCrop.value.set(i.cropLeft, i.cropRight, i.cropTop, i.cropBottom);
    }
  }

  // Which of the two things is on show, and how big the tap target therefore is.
  private applyMode(): void {
    if (!this.plane || !this.hit) return;

    const idle = this.inputs.mode === 'onApproach' && !this.playing;

    this.plane.visible = !idle && !this.useTestPattern;

    if (idle) {
      // Nothing is drawn while she waits, but the spot still has to be
      // tappable: a visitor who walks up should be able to ask for her.
      this.hit.scale.set(0.8, 1.9, 1);
      this.hit.position.y = 0.95;
    } else {
      const g = this.plane.geometry.parameters ?? { width: 1, height: 2 };
      this.hit.scale.set(g.width, g.height, 1);
      this.hit.position.y = this.plane.position.y;
    }
  }

  setMode(mode: 'always' | 'onApproach'): void {
    this.inputs.mode = mode;
    this.applyMode();
  }

  /** How close a visitor must come before she appears. */
  setTriggerRadius(metres: number): void {
    this.inputs.triggerRadius = Math.max(0.5, metres);
  }

  setBrightness(value: number): void {
    this.inputs.brightness = value;
    if (this.material?.uniforms?.uBrightness) {
      this.material.uniforms.uBrightness.value = value;
    }
  }

  /** Fractions trimmed off each edge of the source frame. */
  setCrop(left: number, right: number, top: number, bottom: number): void {
    const clamp = (v: number) => Math.min(0.45, Math.max(0, v));
    this.inputs.cropLeft = clamp(left);
    this.inputs.cropRight = clamp(right);
    this.inputs.cropTop = clamp(top);
    this.inputs.cropBottom = clamp(bottom);
    this.resizePlane();
  }

  /** Lifts or sinks her relative to the floor she is standing on. */
  setGroundOffset(metres: number): void {
    this.inputs.groundOffset = metres;
    this.resizePlane();
  }

  setVisible(next: boolean): void {
    this.inputs.visible = next;
    if (this.root) this.root.visible = next;
  }

  private applyShadow(): void {
    if (!this.shadow) return;
    const d = Math.max(0, this.inputs.shadowDiameter);
    this.shadow.visible = d > 0 && this.inputs.shadowOpacity > 0;
    this.shadow.scale.set(d, d, 1);
    this.shadow.material.opacity = this.inputs.shadowOpacity;
    this.shadow.material.needsUpdate = true;
  }

  setShadow(diameter: number, opacity: number): void {
    this.inputs.shadowDiameter = Math.max(0, Math.round(diameter * 100) / 100);
    this.inputs.shadowOpacity = Math.min(1, Math.max(0, Math.round(opacity * 100) / 100));
    this.applyShadow();
  }

  replay(): void {
    if (this.useTestPattern) return;
    this.rewind();
    void this.play(this.video.muted);
  }

  setHeightMeters(metres: number): void {
    this.inputs.heightMeters = metres;
    this.resizePlane();
  }

  onInputsUpdated() {
    if (!this.material?.uniforms) return;
    const u = this.material.uniforms;
    applyKeyColor(this.context.three, u.uKeyColor.value, this.inputs.keyColor);
    u.uSimilarity.value = this.inputs.similarity;
    u.uSmoothness.value = this.inputs.smoothness;
    u.uSpill.value = this.inputs.spill;
    u.uLumaWeight.value = this.inputs.lumaWeight;
    u.uBrightness.value = this.inputs.brightness;
    u.uKeyLuma.value = keyLuma(this.inputs.keyColor);
    u.uConvertToLinear.value = this.inputs.convertToLinear ? 1 : 0;
    this.root.visible = this.inputs.visible;
    this.video.loop = this.inputs.loop;
  }

  onTick() {
    if (this.inputs.mode === 'onApproach') this.applyMode();
    if (!this.inputs.billboard || !this.root?.visible) return;
    if (!this.camera?.copyPositionInto(this.tmpCamPos)) return;

    this.root.getWorldPosition(this.tmpWorldPos);

    if (this.inputs.billboardMode === 'full') {

      this.root.lookAt(this.tmpCamPos);
      return;
    }

    const dx = this.tmpCamPos.x - this.tmpWorldPos.x;
    const dz = this.tmpCamPos.z - this.tmpWorldPos.z;
    const worldYaw = Math.atan2(dx, dz);

    let parentYaw = 0;
    if (this.root.parent) {
      this.root.parent.getWorldQuaternion(this.tmpParentQuat);
      this.tmpEuler.setFromQuaternion(this.tmpParentQuat, 'YXZ');
      parentYaw = this.tmpEuler.y;
    }
    this.root.rotation.set(0, worldYaw - parentYaw, 0);
  }

  viewerDirection(): { x: number; z: number } | null {
    if (!this.root) return null;
    if (!this.camera?.copyPositionInto(this.tmpCamPos)) return null;
    this.root.getWorldPosition(this.tmpWorldPos);
    const dx = this.tmpWorldPos.x - this.tmpCamPos.x;
    const dz = this.tmpWorldPos.z - this.tmpCamPos.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) return null;
    return { x: dx / length, z: dz / length };
  }

  // A camera looks down its own -Z, so a yaw of t sends that to
  // (-sin t, 0, -cos t). Height carries over from wherever she already stands
  // rather than being derived from the camera: the camera sits at eye level,
  // and subtracting a guessed eye height would sink or float her by however
  // wrong that guess was.
  pointInFrontOfViewer(distance: number): { x: number; y: number; z: number } | null {
    if (!this.root) return null;
    if (!this.camera?.copyPositionInto(this.tmpCamPos)) return null;

    const yaw = this.camera.viewerYaw();
    if (yaw === null) return null;

    this.root.getWorldPosition(this.tmpWorldPos);

    return {
      x: this.tmpCamPos.x - Math.sin(yaw) * distance,
      y: this.tmpWorldPos.y,
      z: this.tmpCamPos.z - Math.cos(yaw) * distance,
    };
  }

  /** Where the viewer is standing, or null if that is not yet known. */
  viewerPosition(): { x: number; y: number; z: number } | null {
    if (!this.camera?.copyPositionInto(this.tmpCamPos)) return null;
    return { x: this.tmpCamPos.x, y: this.tmpCamPos.y, z: this.tmpCamPos.z };
  }

  facingReport(): string {
    if (!this.root) return 'not built';
    if (!this.camera?.copyPositionInto(this.tmpCamPos)) return 'no camera position';
    this.root.getWorldPosition(this.tmpWorldPos);
    const yaw = (this.root.rotation.y * 180) / Math.PI;
    const want =
      (Math.atan2(
        this.tmpCamPos.x - this.tmpWorldPos.x,
        this.tmpCamPos.z - this.tmpWorldPos.z,
      ) *
        180) /
      Math.PI;
    return (
      `facing ${yaw.toFixed(0)}°, wants ${want.toFixed(0)}°, ` +
      `${this.tmpCamPos.distanceTo(this.tmpWorldPos).toFixed(1)}m away, ` +
      `mode ${this.inputs.billboardMode}`
    );
  }

  setBillboardMode(mode: 'yaw' | 'full'): 'yaw' | 'full' {
    this.inputs.billboardMode = mode;
    if (mode === 'yaw') this.root.rotation.x = 0;
    return mode;
  }

  onDestroy() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    this.texture?.dispose();
    this.material?.dispose();
    this.plane?.geometry?.dispose();
    if (this.shadow) {
      this.shadow.geometry.dispose();
      this.shadow.material.map?.dispose();
      this.shadow.material.dispose();
    }
  }

  distanceToViewer(): number {
    if (!this.camera?.copyPositionInto(this.tmpCamPos)) return Infinity;
    this.root.getWorldPosition(this.tmpWorldPos);
    return this.tmpCamPos.distanceTo(this.tmpWorldPos);
  }

  preload() {
    if (this.useTestPattern || this.loaded) return;
    this.loaded = true;
    this.video.preload = 'auto';
    this.video.load();
  }

  async play(muted: boolean) {
    if (this.useTestPattern) return;
    this.preload();
    this.video.muted = muted;
    if (this.video.currentTime < this.inputs.startAt) this.rewind();
    try {
      await this.video.play();
    } catch {

      if (!muted) {
        this.video.muted = true;
        try {
          await this.video.play();
        } catch {

        }
      }
    }
  }

  pause() {
    if (this.useTestPattern) return;
    this.video.pause();
  }

  rewind() {
    try {
      this.video.currentTime = this.inputs.startAt;
    } catch {

    }
  }

  setStartAt(seconds: number): void {
    this.inputs.startAt = Math.max(0, seconds);
    if (this.useTestPattern) return;
    if (!this.playing) this.rewind();
  }

  get playing(): boolean {
    if (this.useTestPattern) return false;
    return !this.video.paused && !this.video.ended;
  }

  get finished(): boolean {
    return this.video.ended;
  }
}

export function presenterComponentFactory() {
  return new ChromaPresenterComponent();
}
