import {
  PRESENTER_COMPONENT,
  presenterComponentFactory,
  DEFAULT_PRESENTER,
  type PresenterInputs,
  type ChromaPresenterComponent,
} from './presenter-component';
import { setSdk } from './camera-source';
import { diag, describeError } from './diagnostics';

import type { DirectorOptions } from './presenter-director';

export type Vec3 = { x: number; y: number; z: number };

export type Placement = {
  id: string;
  position: Vec3;
  inputs?: Partial<PresenterInputs>;
  director?: Partial<DirectorOptions>;
};

export type PresenterHandle = {
  id: string;
  node: any;
  component: ChromaPresenterComponent;
  director?: Partial<DirectorOptions>;
  setPosition: (p: Vec3) => void;
  getPosition: () => Vec3;
};

let registered = false;

async function registerComponent(mpSdk: any, name: string, factory: () => any): Promise<string> {
  if (typeof mpSdk?.Scene?.registerComponents === 'function') {
    try {
      await mpSdk.Scene.registerComponents([{ name, factory }]);
      return 'registerComponents';
    } catch (error) {
      diag.warn(`registerComponents failed for ${name}: ${describeError(error)}`);
    }
  }
  if (typeof mpSdk?.Scene?.register === 'function') {
    await mpSdk.Scene.register(name, factory);
    return 'register';
  }
  throw new Error('Neither Scene.registerComponents nor Scene.register exists.');
}

function addComponentSafely(
  node: any,
  name: string,
  inputs: Record<string, unknown> | undefined,
  label: string,
): any {
  if (inputs) {
    try {
      const component = node.addComponent(name, inputs);
      diag.info(`${label}: added with initial inputs.`);
      return component;
    } catch (error) {
      diag.warn(`${label}: initial-inputs path failed (${describeError(error)}). Retrying.`);
    }
  }

  const component = node.addComponent(name);
  if (inputs) {
    if (component?.inputs) {
      Object.assign(component.inputs, inputs);
      diag.info(`${label}: added bare, inputs assigned afterwards.`);
    } else {
      diag.warn(`${label}: added bare, but it exposes no inputs to assign.`);
    }
  } else {
    diag.info(`${label}: added.`);
  }
  return component;
}

export async function spawnPresenters(
  mpSdk: any,
  placements: Placement[],
  wantLights = false,
): Promise<PresenterHandle[]> {
  setSdk(mpSdk);

  if (!mpSdk?.Scene?.register) {
    throw new Error('This SDK object has no Scene.register — the Scene API is unavailable.');
  }

  if (!registered) {
    const via = await registerComponent(
      mpSdk,
      PRESENTER_COMPONENT,
      presenterComponentFactory,
    );
    registered = true;
    diag.info(`Presenter component registered via ${via}.`);
  }

  const [sceneObject] = await mpSdk.Scene.createObjects(1);
  if (!sceneObject) throw new Error('Scene.createObjects returned nothing.');

  if (wantLights) {
    try {
      const lights = sceneObject.addNode();
      addComponentSafely(lights, 'mp.lights', undefined, 'Light rig');
    } catch (error) {
      diag.warn(`Light rig skipped: ${describeError(error)}`);
    }
  }

  const handles: PresenterHandle[] = placements.map((placement) => {
    const node = sceneObject.addNode();

    const component = addComponentSafely(
      node,
      PRESENTER_COMPONENT,
      {
        ...DEFAULT_PRESENTER,
        id: placement.id,
        ...placement.inputs,
      },
      `Presenter "${placement.id}"`,
    ) as ChromaPresenterComponent;

    setNodePosition(node, placement.position);

    return {
      id: placement.id,
      node,
      component,
      director: placement.director,
      setPosition: (p: Vec3) => setNodePosition(node, p),
      getPosition: () => getNodePosition(node),
    };
  });

  sceneObject.start();
  diag.info(`${handles.length} presenter(s) started.`);
  return handles;
}

export function addLightRig(sceneObject: any): void {
  try {
    const lights = sceneObject.addNode();
    addComponentSafely(lights, 'mp.lights', undefined, 'Light rig');
  } catch (error) {
    diag.warn(`Light rig skipped: ${describeError(error)}`);
  }
}

function transformOf(node: any): any {
  return node.obj3D ?? node;
}

export function setNodePosition(node: any, p: Vec3): void {
  transformOf(node).position.set(p.x, p.y, p.z);
}

export function getNodePosition(node: any): Vec3 {
  const { x, y, z } = transformOf(node).position;
  return { x, y, z };
}
