import {
  createChromaKeyMaterial,
  setNoColorConversion,
  applyKeyColor,
  keyLuma,
  DEFAULT_CHROMA,
  type ChromaKeyOptions,
} from './chroma-key-material';
import { ensureCameraSource, type CameraSource } from './camera-source';
import { createTestPattern, type TestPattern } from './test-pattern';
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
  // What marks the spot while she is waiting.
  //  'spin'   a 3D ring turning in the air — reads as interactive from across
  //           a room, because nothing else in a scanned space moves
  //  'static' a flat disc facing the viewer — quieter, better where several
  //           stations are visible at once and motion would compete
  //  'off'    nothing; the space looks untouched until she appears
  beaconStyle: 'spin' | 'static' | 'off';
  // Resting orientation in degrees. A block meant to sit against a shelf or in
  // a corner has to be aimed by hand; a single yaw is not enough.
  /** Ring rotations per minute. 0 stops it without changing the style. */
  beaconSpeed: number;
  beaconTurn: number;
  beaconTilt: number;
  beaconRoll: number;
  /** Marker size in metres. */
  beaconSize: number;
  /** Marker height above the floor, in metres. */
  beaconHeight: number;
  /** How close a visitor must be before she appears, in metres. */
  triggerRadius: number;

  // The sign above the ring: what this stop is about.
  //
  // Deliberately separate from the ring rather than part of it. The ring turns,
  // and text that turns with it is unreadable for most of every revolution. The
  // sign hangs off the presenter's root instead, which already faces the
  // viewer, so it is always square-on while the blocks spin beneath it.
  signText: string;
  /** Sign height in metres. Width follows the text. */
  signSize: number;
  /** Cap height as a fraction of the sign's height. */
  signFont: number;
  signShape: 'rect' | 'rounded' | 'pill';
  /** Show a floating marker when she is not speaking. */
  beacon: boolean;
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
  beacon: true,
  beaconStyle: 'spin',
  signText: '',
  signSize: 0.34,
  signFont: 0.42,
  signShape: 'rounded',
  beaconSpeed: 8,
  beaconTurn: 0,
  beaconTilt: 0,
  beaconRoll: 0,
  beaconSize: 0.34,
  beaconHeight: 1.5,
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

// A floating ring with a speech notch, drawn rather than imported so there is
// no asset to host and it recolours with one line.
// Two markers in one group, so switching style is a visibility flip rather
// than a rebuild.
//
// The spinning form is a real torus rather than a picture of a ring: a flat
// image rotating about its own vertical axis vanishes edge-on twice a turn,
// which reads as a flicker rather than a rotation. A torus stays solid from
// every angle.
//
// The static form is a flat disc. Because both hang off the presenter's root,
// which already yaws to face the viewer, the disc is always presented squarely
// without any billboarding of its own.
// A ring of Bellbird blocks, letters facing outwards.
//
// Colours and letters sampled from the wordmark itself rather than eyeballed:
// the logo is a row of coloured letter blocks spelling BELLBIRD, and these are
// its own values in its own order.
const WORDMARK = [
  { letter: 'B', colour: '#e20a22' },
  { letter: 'E', colour: '#fdc30f' },
  { letter: 'L', colour: '#693b90' },
  { letter: 'L', colour: '#33b8f0' },
  { letter: 'B', colour: '#a03888' },
  { letter: 'I', colour: '#3a4290' },
  { letter: 'R', colour: '#40a838' },
  { letter: 'D', colour: '#e9511c' },
];

/**
 * One glazed face: a rounded inset panel with a soft sheen, then the letter.
 *
 * The rounding and the sheen are painted rather than modelled. A real bevel
 * would mean eight rounded boxes of extra geometry for something only ever seen
 * at a distance, and the eye reads a highlight along one edge as a curved
 * surface perfectly well.
 */
function blockFace(THREE: any, colour: string, letter?: string): any {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, size, size);

  // A slightly darker rim, so each face reads as a separate glazed tile rather
  // than the blocks melting into one another where they meet.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = size * 0.07;
  ctx.strokeRect(0, 0, size, size);

  // Glaze: a broad highlight from the upper left falling off to nothing.
  const sheen = ctx.createLinearGradient(0, 0, size, size);
  sheen.addColorStop(0, 'rgba(255,255,255,0.30)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0.05)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);

  if (letter) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${size * 0.66}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    // A capital sits above its own baseline, so the glyph's optical centre is
    // not the box's centre.
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, size / 2, size * 0.55);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

// The sign, drawn as a glazed label to match the blocks.
//
// Off-white rather than white: a pure white panel next to saturated ceramic
// reads as a UI overlay pasted onto the scene, where a warm off-white reads as
// an object in the room. The keyline is the wordmark's red, which ties it to
// the blocks without competing with them.
function makeSign(THREE: any, inputs: any): any {
  const text = String(inputs.signText ?? '').trim();
  if (!text) return null;

  const H = 256;
  const pad = H * 0.34;
  const radius =
    inputs.signShape === 'pill' ? H / 2 : inputs.signShape === 'rounded' ? H * 0.18 : 0;

  // Measure first, then size the canvas to the text. Fixing the canvas and
  // shrinking the text to fit makes every sign a different size on screen;
  // fixing the height and letting width follow keeps them a consistent family.
  const cap = Math.max(H * 0.16, Math.min(H * 0.62, H * inputs.signFont));
  const font = `600 ${cap}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;

  const gauge = document.createElement('canvas').getContext('2d')!;
  gauge.font = font;
  const W = Math.ceil(Math.min(2048, gauge.measureText(text).width + pad * 2));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const panel = (inset: number) => {
    ctx.beginPath();
    ctx.roundRect(inset, inset, W - inset * 2, H - inset * 2, Math.max(0, radius - inset));
    ctx.closePath();
  };

  ctx.fillStyle = '#f7f4ee';
  panel(0);
  ctx.fill();

  // A soft top-down shading, the same trick as the block glaze, so the sign
  // sits in the same light rather than looking flat beside them.
  const glaze = ctx.createLinearGradient(0, 0, 0, H);
  glaze.addColorStop(0, 'rgba(255,255,255,0.55)');
  glaze.addColorStop(0.55, 'rgba(255,255,255,0)');
  glaze.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = glaze;
  panel(0);
  ctx.fill();

  ctx.strokeStyle = '#e20a22';
  ctx.lineWidth = H * 0.045;
  panel(ctx.lineWidth / 2);
  ctx.stroke();

  ctx.fillStyle = '#1d2430';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H * 0.54);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;

  const height = inputs.signSize;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(height * (W / H), height),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.renderOrder = 12;
  return mesh;
}

function makeBeacon(THREE: any): any {
  const group = new THREE.Object3D();

  // Lights live on the ring's parent, not the ring, so they stay put while the
  // blocks turn through them. Parented to the ring instead, every highlight
  // would travel with its own face and the rotation would read as a still
  // image sliding sideways.
  //
  // Ambient is deliberately generous: if the renderer gives the directionals
  // nothing to work with, the blocks still show their own colours rather than
  // going black.
  const lights = new THREE.Object3D();
  lights.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 1, 0.8);
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-0.7, -0.2, -0.5);
  lights.add(fill);
  group.add(lights);

  const ring = new THREE.Object3D();
  ring.name = 'ring';
  group.add(ring);

  const radius = 0.5;
  const cube = 0.26;
  const geometry = new THREE.BoxGeometry(cube, cube, cube);

  WORDMARK.forEach((entry, index) => {
    // Phong rather than the flat basic material: a dielectric with a tight
    // specular is what makes a surface read as glazed ceramic instead of
    // printed card. Metalness would read as plastic or metal, so the specular
    // stays white and the body colour does the work.
    const surface = (map?: any) =>
      new THREE.MeshPhongMaterial({
        color: map ? 0xffffff : new THREE.Color(entry.colour),
        map,
        specular: new THREE.Color(0x8a8a8a),
        shininess: 55,
        // A little self-colour so a face turned away from both lights keeps
        // its identity rather than dropping to black.
        emissive: new THREE.Color(entry.colour),
        emissiveIntensity: 0.18,
      });

    const plain = surface();
    const front = surface(blockFace(THREE, entry.colour, entry.letter));

    // Face order is +X, -X, +Y, -Y, +Z, -Z: the letter goes on +Z.
    const block = new THREE.Mesh(geometry, [plain, plain, plain, plain, front, plain]);

    const angle = (index / WORDMARK.length) * Math.PI * 2;
    block.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
    // Turning each block to match its own angle points its lettered face
    // radially outward, so the ring reads as the wordmark from any side.
    block.rotation.y = angle;

    ring.add(block);
  });

  group.renderOrder = 11;
  return group;
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
  gradient.addColorStop(0, 'rgba(0,0,0,0.45)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.18)');
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
  private beacon: any;
  private sign: any;
  private hit: any;
  private spin = 0;
  private shadow: any;
  private material: any;
  private texture: any;
  private camera: CameraSource | null = null;
  private testPattern: TestPattern | null = null;

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
      this.testPattern = createTestPattern(this.inputs.keyColor);
      this.texture = new THREE.CanvasTexture(this.testPattern.canvas);

    } else {
      this.texture = new THREE.VideoTexture(this.video);
    }
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
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
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.015;
    this.shadow.renderOrder = 9;
    this.root.add(this.shadow);
    this.applyShadow();

    this.beacon = makeBeacon(THREE);
    this.root.add(this.beacon);
    this.rebuildSign();
    this.applyBeacon();

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

    if (this.useTestPattern) this.testPattern!.start();

    diag.info(`${this.inputs.id}: built (${this.useTestPattern ? 'stand-in' : 'video'}).`);
  }

  onEvent(eventType: string) {
    if (eventType === 'INTERACTION.CLICK') this.onClick?.();
  }

  useVideo(url: string, label = 'video'): void {
    const THREE = this.context.three;

    this.testPattern?.stop();
    this.testPattern = null;
    this.useTestPattern = false;
    this.loaded = true;

    this.video.src = url;
    this.video.preload = 'auto';
    this.video.loop = this.inputs.loop;

    this.texture?.dispose();
    this.texture = new THREE.VideoTexture(this.video);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
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
    if (!this.plane || !this.beacon || !this.hit) return;

    const idle = this.inputs.mode === 'onApproach' && !this.playing;
    if (this.sign) this.sign.visible = idle && this.inputs.beaconStyle !== 'off';

    this.plane.visible = !idle;
    this.beacon.visible = this.inputs.beaconStyle !== 'off' && this.inputs.beacon && idle;

    if (idle) {
      // Sized and placed from the marker itself. Hard-coding 1.5m meant that
      // moving the marker left its tap target behind, so tapping the block did
      // nothing — which reads as the marker being decorative.
      const reach = Math.max(0.6, this.inputs.beaconSize * 1.6);
      this.hit.scale.set(reach, reach, 1);
      this.hit.position.y = this.inputs.beaconHeight;
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

  setBeacon(on: boolean): void {
    this.inputs.beacon = on;
    this.applyMode();
  }

  /** Size in metres, height above the floor in metres. */
  setBeaconShape(size: number, height: number): void {
    this.inputs.beaconSize = Math.max(0.05, size);
    this.inputs.beaconHeight = height;
    this.applyBeacon();
  }

  /** Resting orientation in degrees, so the block can sit against anything. */
  setBeaconAngles(turn: number, tilt: number, roll: number): void {
    this.inputs.beaconTurn = turn;
    this.inputs.beaconTilt = tilt;
    this.inputs.beaconRoll = roll;
    this.applyBeacon();
  }

  /** Rebuilds the sign from the current text, shape and font settings. */
  private rebuildSign(): void {
    if (this.sign) {
      this.root.remove(this.sign);
      this.sign.geometry?.dispose?.();
      this.sign.material?.map?.dispose?.();
      this.sign.material?.dispose?.();
      this.sign = null;
    }
    const built = makeSign(this.context.three, this.inputs);
    if (built) {
      this.sign = built;
      this.root.add(this.sign);
    }
    this.applyBeacon();
  }

  setSign(text: string, size: number, font: number, shape: 'rect' | 'rounded' | 'pill'): void {
    this.inputs.signText = text;
    this.inputs.signSize = Math.max(0.05, size);
    this.inputs.signFont = font;
    this.inputs.signShape = shape;
    this.rebuildSign();
  }

  setBeaconStyle(style: 'spin' | 'static' | 'off'): void {
    this.inputs.beaconStyle = style;
    this.applyBeacon();
    this.applyMode();
  }

  /** How close a visitor must come before she appears. */
  /** Ring rotations per minute. */
  setBeaconSpeed(rpm: number): void {
    this.inputs.beaconSpeed = rpm;
  }

  setTriggerRadius(metres: number): void {
    this.inputs.triggerRadius = Math.max(0.5, metres);
  }

  private applyBeacon(): void {
    if (!this.beacon) return;
    const { beaconSize, beaconHeight } = this.inputs;

    this.beacon.scale.set(beaconSize, beaconSize, beaconSize);
    this.beacon.position.y = beaconHeight;

    const rad = Math.PI / 180;
    this.beacon.rotation.set(
      this.inputs.beaconTilt * rad,
      this.inputs.beaconTurn * rad,
      this.inputs.beaconRoll * rad,
    );

    if (this.sign) {
      // Clear of the ring at any size or angle: half the ring's own extent plus
      // half the sign, plus a small breath. Measured rather than a constant, so
      // resizing either one never has them overlap.
      const clearance = beaconSize * 0.8 + this.inputs.signSize * 0.5 + 0.06;
      this.sign.position.y = beaconHeight + clearance;
    }
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
    if (this.useTestPattern) {
      this.testPattern!.start();
      return;
    }
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

  onTick(delta = 16) {
    if (this.testPattern?.running) this.texture.needsUpdate = true;

    // Only the spinning style animates. Turning the static disc would defeat
    // the point of offering it, and the height must come from the input rather
    // than a constant or the Marker height slider is overwritten every frame.
    if (this.beacon?.visible && this.inputs.beaconStyle === 'spin') {
      // rpm to radians per millisecond.
      // Negative: a positive yaw turns anticlockwise seen from above, and a
      // marker that unwinds itself reads as running backwards.
      this.spin -= delta * this.inputs.beaconSpeed * ((Math.PI * 2) / 60000);
      this.beacon.rotation.y = this.inputs.beaconTurn * (Math.PI / 180) + this.spin;
      this.beacon.position.y =
        this.inputs.beaconHeight + Math.sin(this.spin * 1.6) * 0.04;
    }

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
    this.testPattern?.stop();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    this.texture?.dispose();
    this.material?.dispose();
    this.plane?.geometry?.dispose();
    // The beacon is a group of meshes with shared geometry and per-face
    // materials, so it has to be walked. Reaching for .geometry on the group
    // itself — which is what this did while it was one mesh — throws.
    this.beacon?.traverse((node: any) => {
      node.geometry?.dispose?.();
      const material = node.material;
      if (Array.isArray(material)) {
        for (const one of material) {
          one.map?.dispose?.();
          one.dispose?.();
        }
      } else {
        material?.map?.dispose?.();
        material?.dispose?.();
      }
    });
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
    if (this.useTestPattern) {
      this.testPattern!.start();
      return;
    }
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
    if (this.useTestPattern) {
      this.testPattern!.stop();
      return;
    }
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
    if (this.useTestPattern) return this.testPattern!.running;
    return !this.video.paused && !this.video.ended;
  }

  get finished(): boolean {
    return this.video.ended;
  }
}

export function presenterComponentFactory() {
  return new ChromaPresenterComponent();
}
