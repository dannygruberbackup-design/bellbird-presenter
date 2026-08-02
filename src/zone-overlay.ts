// The zone rectangles, drawn on the floor.
//
// Authoring zones without seeing them is guesswork: you place two corners, walk
// away, and find out later that the rectangle you meant is not the rectangle
// you made. These slabs make the model visible, so a wrong corner is obvious in
// the floor-plan view rather than three zones later.
//
// They exist only while you are drawing. A visitor never sees them.

import type { Area, AreaState } from './areas';

export const ZONE_OVERLAY_COMPONENT = 'zoneOverlay';

/** Distinct hues, cycled. Nineteen named colours would be nineteen decisions. */
const HUES = [4, 42, 96, 152, 198, 232, 268, 312];

// Label textures are cached by name and hue. Rebuilding is now driven by a
// drag, which fires many times a second; drawing nineteen canvases on every
// move would stall the drag it is meant to preview.
const labels = new Map<string, any>();

export class ZoneOverlayComponent {
  inputs: Record<string, unknown> = {};
  outputs: { objectRoot: any } = {} as { objectRoot: any };
  context!: any;

  private root: any;

  onInit() {
    this.root = new this.context.three.Object3D();
    this.outputs.objectRoot = this.root;
  }

  /**
   * Replaces every slab with the current set of zones.
   *
   * `selected` is marked out because nineteen coloured rectangles all look
   * alike from overhead, and redrawing the wrong one is a mistake you only
   * notice later.
   */
  rebuild(
    zones: { area: Area; state: AreaState }[],
    buildingAngle: number,
    selected?: string,
  ): void {
    const THREE = this.context.three;
    if (!this.root) return;

    for (const child of [...this.root.children]) {
      this.root.remove(child);
      child.geometry?.dispose?.();
      // The map is deliberately not disposed: it is shared from the cache and
      // will be handed straight back on the next rebuild.
      child.material?.dispose?.();
    }

    zones.forEach(({ area, state }, index) => {
      const a = state.cornerA!;
      const b = state.cornerB!;

      // Corners are stored in world space, so the rectangle's extent has to be
      // measured in the building's frame or a rotated building gives a slab
      // that is the right size but the wrong shape.
      const t = (-buildingAngle * Math.PI) / 180;
      const cos = Math.cos(t);
      const sin = Math.sin(t);
      const local = (p: { x: number; z: number }) => ({
        x: p.x * cos - p.z * sin,
        z: p.x * sin + p.z * cos,
      });
      const la = local(a);
      const lb = local(b);

      const width = Math.max(0.2, Math.abs(la.x - lb.x));
      const depth = Math.max(0.2, Math.abs(la.z - lb.z));
      const hue = HUES[index % HUES.length];
      const isSelected = area.id === selected;

      const slab = new THREE.Mesh(
        new THREE.PlaneGeometry(width, depth),
        new THREE.MeshBasicMaterial({
          map: cachedLabel(THREE, area.name, hue, isSelected),
          transparent: true,
          opacity: isSelected ? 0.85 : 0.5,
          depthWrite: false,
          // Drawn over the floor rather than fighting it for depth. A slab a
          // few centimetres above a scanned floor z-fights badly, and in plan
          // view it would flicker in and out as the camera moves.
          depthTest: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );

      slab.rotation.set(-Math.PI / 2, 0, (buildingAngle * Math.PI) / 180);
      // Just above the floor the corners were recorded at. Averaging the two
      // rather than taking the higher one keeps a slab flat when a zone spans a
      // slight change in level.
      slab.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.04, (a.z + b.z) / 2);
      // The selected zone draws last so it is never hidden under a neighbour
      // it overlaps, which is exactly when you most need to see it.
      slab.renderOrder = isSelected ? 21 : 20;
      this.root.add(slab);
    });
  }

  onDestroy() {
    for (const child of this.root?.children ?? []) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
    for (const texture of labels.values()) texture.dispose?.();
    labels.clear();
  }
}

function cachedLabel(THREE: any, name: string, hue: number, selected: boolean): any {
  const key = `${name}|${hue}|${selected}`;
  const found = labels.get(key);
  if (found) return found;
  const made = label(THREE, name, hue, selected);
  labels.set(key, made);
  return made;
}

/** A tinted panel with the zone's name across it. */
function label(THREE: any, name: string, hue: number, selected = false): any {
  const W = 512;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = `hsla(${hue}, 62%, 52%, 0.55)`;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = selected ? '#ffffff' : `hsla(${hue}, 70%, 32%, 0.95)`;
  ctx.lineWidth = selected ? 20 : 10;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 44px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 10;
  ctx.fillText(name, W / 2, H / 2);

  return new THREE.CanvasTexture(canvas);
}

export function zoneOverlayFactory() {
  return new ZoneOverlayComponent();
}
