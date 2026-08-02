// A box built in code, placed alongside a loaded model.
//
// When nothing appears there are two quite different causes and no way to tell
// them apart from the outside: either the node is in the wrong place (or not in
// the scene at all), or the node is fine and the loader failed. This draws a
// 1m box at the same node, using the scene's own three. If the box appears and
// the model does not, the placement is sound and the loader is the problem.

export const MODEL_PROBE_COMPONENT = 'modelProbe';

export class ModelProbeComponent {
  inputs: { size: number } = { size: 1 };
  outputs: { objectRoot: any } = {} as { objectRoot: any };
  context!: any;

  private root: any;

  onInit() {
    const THREE = this.context.three;
    this.root = new THREE.Object3D();

    const size = this.inputs.size;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#e20a22'),
        wireframe: true,
        depthTest: false,
        toneMapped: false,
      }),
    );
    // Origin at the base, matching the test cube, so the two coincide exactly.
    box.position.y = size / 2;
    box.renderOrder = 30;
    this.root.add(box);

    this.outputs.objectRoot = this.root;
  }

  onDestroy() {
    for (const child of this.root?.children ?? []) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
  }
}

export function modelProbeFactory() {
  return new ModelProbeComponent();
}
