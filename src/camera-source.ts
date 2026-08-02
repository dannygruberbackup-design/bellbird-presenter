import { diag } from './diagnostics';
import { CAMERA_SOURCE, IS_DEV } from './config';

export type CameraSource = {
  readonly mode: 'context' | 'pose' | 'unavailable';
  copyPositionInto(target: any): boolean;
  /**
   * Which way the viewer is looking, as a yaw in radians, or null if unknown.
   *
   * Needed for anything positioned relative to the viewer rather than merely
   * near them. Position alone answers "how far away"; it cannot answer "in
   * front of".
   */
  viewerYaw(): number | null;
  dispose(): void;
};

let sharedSdk: any = null;
let shared: CameraSource | null = null;

export function setSdk(mpSdk: any): void {
  sharedSdk = mpSdk;
}

export function ensureCameraSource(THREE: any, context: any): CameraSource {
  if (shared) return shared;
  shared = createCameraSource(THREE, context, sharedSdk);
  diag.info(`Camera source: ${shared.mode}`);
  return shared;
}

export function disposeCameraSource(): void {
  shared?.dispose();
  shared = null;
}

function createCameraSource(THREE: any, context: any, mpSdk: any): CameraSource {
  const contextCamera = context?.camera;
  const posed = mpSdk?.Camera?.pose?.subscribe ? subscribePose(THREE, mpSdk) : null;

  if (IS_DEV && posed && contextCamera?.position) {
    startCameraAudit(contextCamera, posed);
  }

  if (CAMERA_SOURCE === 'pose' && posed) return posed;

  if (contextCamera?.position && typeof contextCamera.position.x === 'number') {
    return {
      mode: 'context',
      copyPositionInto(target) {
        target.copy(contextCamera.position);
        return true;
      },
      viewerYaw: () => posed?.viewerYaw() ?? null,
      dispose() {},
    };
  }

  if (posed) return posed;

  diag.warn(
    'No camera source available. Billboarding and proximity are off; the ' +
      'presenter still renders and plays on tap.',
  );
  return {
    mode: 'unavailable',
    copyPositionInto: () => false,
    viewerYaw: () => null,
    dispose() {},
  };
}

function subscribePose(THREE: any, mpSdk: any): CameraSource {
  const cached = new THREE.Vector3();
  let received = false;
  let yaw: number | null = null;

  const subscription = mpSdk.Camera.pose.subscribe((pose: any) => {
    if (!pose?.position) return;
    cached.set(pose.position.x, pose.position.y, pose.position.z);
    // Matterport reports rotation in degrees; y is the yaw.
    if (typeof pose.rotation?.y === 'number') {
      yaw = (pose.rotation.y * Math.PI) / 180;
    }
    received = true;
  });

  return {
    mode: 'pose',
    copyPositionInto(target) {
      if (!received) return false;
      target.copy(cached);
      return true;
    },
    viewerYaw: () => yaw,
    dispose() {
      subscription?.cancel?.();
    },
  };
}

const probe = {
  x: 0,
  y: 0,
  z: 0,
  copy(v: any) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  },
};

function startCameraAudit(contextCamera: any, posed: CameraSource): void {
  let last = '';
  let changes = 0;

  window.setInterval(() => {
    const c = contextCamera.position;
    const havePose = posed.copyPositionInto(probe);

    const signature = `${c.x.toFixed(2)},${c.z.toFixed(2)}`;
    if (signature !== last) changes += 1;
    last = signature;

    const apart = havePose
      ? Math.hypot(c.x - probe.x, c.y - probe.y, c.z - probe.z)
      : NaN;

    diag.info(
      `camera: context (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)})` +
        (havePose
          ? ` | pose (${probe.x.toFixed(2)}, ${probe.y.toFixed(2)}, ${probe.z.toFixed(2)})` +
            ` | apart ${apart.toFixed(2)}m`
          : ' | pose not received') +
        ` | moved ${changes}x`,
    );
  }, 4000);
}
