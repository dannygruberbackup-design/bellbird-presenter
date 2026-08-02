import { diag } from './diagnostics';

// The floor circles a visitor can stand on.
//
// These are the closest thing to furniture detection available. The SDK exposes
// geometry and panoramas, not object recognition — nothing tells you "that is a
// chair". But a sweep is a spot where the capture camera physically stood, so
// it is walkable floor by definition: never inside a table, never on a seat,
// never behind a wall. Snapping to one is a stronger signal than furniture
// detection would be, because it is a positive statement about where a person
// CAN stand rather than a guess about where they cannot.
//
// Each sweep also carries its own height, which is what stops the presenter
// floating when she is summoned somewhere on a different level.

export type Sweep = { x: number; y: number; z: number; sid: string };

const sweeps: Sweep[] = [];

/** Every known circle, for anything that needs a spread of known points. */
export function allSweeps(): Sweep[] {
  return sweeps;
}

export function sweepCount(): number {
  return sweeps.length;
}

/**
 * The collection API has changed shape across SDK versions, so both the
 * observable-collection form and a plain callback are handled. Failing is not
 * fatal — callers fall back to an unsnapped point.
 */
export function subscribeSweeps(mpSdk: any): void {
  const data = mpSdk?.Sweep?.data;
  if (!data?.subscribe) {
    diag.warn('Sweep list unavailable — snapping to floor circles is off.');
    return;
  }

  const take = (sweep: any) => {
    const p = sweep?.position;
    // The id is what Sweep.moveTo needs; without it a station can be found but
    // not travelled to.
    if (p && typeof p.x === 'number') {
      sweeps.push({ x: p.x, y: p.y, z: p.z, sid: sweep.sid ?? sweep.id ?? '' });
    }
  };

  const readCollection = (collection: any) => {
    sweeps.length = 0;
    for (const key of Object.keys(collection ?? {})) take(collection[key]);
    diag.info(`${sweeps.length} floor circles found.`);
  };

  try {
    data.subscribe({
      onAdded(_index: any, item: any) {
        take(item);
      },
      onCollectionUpdated: readCollection,
    });
  } catch {
    try {
      data.subscribe(readCollection);
    } catch {
      diag.warn('Could not read the sweep list; snapping is off.');
    }
  }
}

/**
 * Nearest circle on the floor plane, within `reach` metres.
 *
 * Distance is measured horizontally only. A circle directly below on another
 * storey is not "near" in any sense a visitor would recognise, and including
 * height in the comparison would let one win over a closer circle on this
 * floor.
 */
export function nearestSweep(to: { x: number; z: number }, reach = 2.5): Sweep | null {
  let best: Sweep | null = null;
  let bestDistance = reach;

  for (const sweep of sweeps) {
    const d = Math.hypot(sweep.x - to.x, sweep.z - to.z);
    if (d < bestDistance) {
      bestDistance = d;
      best = sweep;
    }
  }
  return best;
}
