import { diag } from './diagnostics';
import { CAMERA_SOURCE } from './config';

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

