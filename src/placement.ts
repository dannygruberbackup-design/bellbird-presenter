import type { PresenterHandle, Placement, Vec3 } from './scene';
import { diag } from './diagnostics';
import { nearestSweep, sweepCount } from './sweeps';

// Author-time tool for positioning presenters. Placements are not stored by
// Matterport; this produces the JSON you save on your own side.
export function createPlacementMode(
  mpSdk: any,
  getHandle: () => PresenterHandle | null,
  allHandles: () => PresenterHandle[],
  onChange?: () => void,
) {
  let active = false;
  let snapToSweeps = true;
  let lastIntersection: { position: Vec3 } | null = null;

  const intersectionSub = mpSdk?.Pointer?.intersection?.subscribe?.((intersection: any) => {
    lastIntersection = intersection;
  });

  if (!intersectionSub) diag.warn('Pointer.intersection unavailable — tap-to-place is off.');

  function place() {
    const handle = getHandle();
    if (!active || !lastIntersection || !handle) return;

    const tapped = lastIntersection.position;
    const snapped = snapToSweeps ? nearestSweep(tapped) : null;

    // A tap gives the true floor height at that exact point, which is the most
    // trustworthy floor reading available. A circle only knows where the camera
    // stood, roughly eye level, so its x and z are used but never its y.
    const target = snapped
      ? { x: snapped.x, y: tapped.y, z: snapped.z }
      : { x: tapped.x, y: tapped.y, z: tapped.z };

    handle.setPosition(target);

    // Every tap is a free calibration of camera height above floor, which is
    // what lets a summon land her on the floor rather than in the air.
    if (snapped) calibrateFloorOffset(snapped.y - tapped.y);

    diag.info(
      snapped
        ? `Placed on the nearest circle: ${JSON.stringify(roundVec(target))}`
        : `Placed at ${JSON.stringify(roundVec(target))}`,
    );
    onChange?.();
  }

  let onCalibrated: ((offset: number) => void) | null = null;

  function calibrateFloorOffset(offset: number) {
    // Sanity bound: a capture camera sits somewhere around chest to eye height.
    // Anything outside this means the tap or the circle was misread, and a wild
    // value would strand every future summon.
    if (offset > 0.8 && offset < 2.2) onCalibrated?.(offset);
  }

  function setSnap(next: boolean) {
    snapToSweeps = next;
    diag.info(
      next
        ? `Snapping to floor circles (${sweepCount()} known).`
        : 'Free placement: taps land exactly where you touch.',
    );
  }

  function nudge(axis: keyof Vec3, delta: number) {
    const handle = getHandle();
    if (!handle) return;
    const p = handle.getPosition();
    handle.setPosition({ ...p, [axis]: p[axis] + delta });
    onChange?.();
  }

  function exportPlacements(): Placement[] {
    return allHandles().map((h) => ({ id: h.id, position: roundVec(h.getPosition()) }));
  }

  function onPointerDown(evt: PointerEvent) {
    if ((evt.target as HTMLElement)?.closest('[data-ui]')) return;
    place();
  }

  async function copyToClipboard() {
    const json = JSON.stringify(exportPlacements(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      diag.info('Placements copied to clipboard.');
    } catch {
      diag.warn('Clipboard blocked. Placements: ' + json);
    }
  }

  function setActive(next: boolean) {
    active = next;
    document.body.classList.toggle('placement-active', active);
    diag.info(
      active
        ? `Placement mode ON — tap a floor circle (${sweepCount()} found).`
        : 'Placement mode off.',
    );
  }

  window.addEventListener('pointerdown', onPointerDown);

  return {
    get active() {
      return active;
    },
    get snapping() {
      return snapToSweeps;
    },
    setActive,
    setSnap,
    exportPlacements,
    copyToClipboard,
    nudge,
    set onFloorOffsetLearned(fn: (offset: number) => void) {
      onCalibrated = fn;
    },
    dispose() {
      window.removeEventListener('pointerdown', onPointerDown);
      intersectionSub?.cancel?.();
    },
  };
}

function roundVec(v: Vec3): Vec3 {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { x: r(v.x), y: r(v.y), z: r(v.z) };
}
