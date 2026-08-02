import type { PresenterHandle } from './scene';
import { nearestSweep } from './sweeps';
import { diag } from './diagnostics';

// The areas of the showroom, as a visitor experiences them.
//
// Each placed guide is an area: somewhere worth standing, with something to say
// about it. The menu, the walkthrough and the proximity trigger are three ways
// into the same list rather than three features, which is why they all read
// from here.

export type Station = {
  handle: PresenterHandle;
  label: string;
};

/** Only placed guides count: an unplaced slot is not somewhere to send anyone. */
export function stationsFrom(
  handles: PresenterHandle[],
  labelOf: (h: PresenterHandle) => string,
): Station[] {
  return handles
    .filter((h) => h.component.inputs.visible)
    .map((handle) => ({ handle, label: labelOf(handle) }));
}

/** True when the visitor is inside this area. */
export function isInside(station: Station): boolean {
  const distance = station.handle.component.distanceToViewer();
  if (!Number.isFinite(distance)) return false;
  return distance <= station.handle.component.inputs.triggerRadius;
}

/**
 * Travels to an area, then runs `onArrived`.
 *
 * Travel first, speak second. Starting a clip before the camera lands means
 * hearing the opening line while still looking at the last room, which reads as
 * a glitch rather than a greeting.
 */
export async function goToStation(
  mpSdk: any,
  station: Station,
  onArrived: () => void,
  destination?: { x: number; y: number; z: number },
): Promise<void> {
  const position = destination ?? station.handle.getPosition();
  const circle = nearestSweep(position, 6);

  if (circle?.sid && mpSdk?.Sweep?.moveTo) {
    try {
      await mpSdk.Sweep.moveTo(circle.sid, { transition: 'fly', transitionTime: 1400 });
    } catch {
      diag.warn(`No travel to ${station.label}.`);
    }
  } else {
    diag.warn(`No circle near ${station.label}.`);
  }

  onArrived();
}

/**
 * Turns the camera to look at a point.
 *
 * Without this, asking for the guide while facing a wall puts her politely
 * behind your shoulder. A camera looks down its own -Z, so a yaw of t points it
 * along (-sin t, -cos t); solving that for the direction to her gives the yaw
 * below. Pitch is left at zero deliberately: she stands on the floor, and
 * tipping the view down to find her feet is not what anyone wants.
 */
export async function lookAt(
  mpSdk: any,
  target: { x: number; y: number; z: number },
  from: { x: number; y: number; z: number },
): Promise<void> {
  const yaw = (Math.atan2(-(target.x - from.x), -(target.z - from.z)) * 180) / Math.PI;
  try {
    await mpSdk?.Camera?.setRotation?.({ x: 0, y: yaw }, { speed: 60 });
  } catch {
    // Older bundles expose rotate() instead; not worth failing the summon over.
    diag.warn('Could not turn the camera.');
  }
}
