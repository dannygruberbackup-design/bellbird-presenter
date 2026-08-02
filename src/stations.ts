import type { PresenterHandle } from './scene';
import { allSweeps, nearestSweep } from './sweeps';
import { areaState, distanceToArea, type Area, type AreaState } from './areas';
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
    // The transition is an enum, not the bare word. Matterport's values look
    // like 'transition.fly', and passing 'fly' throws — which the old catch
    // reported as a travel failure without ever saying why.
    const transition = mpSdk?.Sweep?.Transition?.FLY ?? 'transition.fly';
    try {
      await mpSdk.Sweep.moveTo(circle.sid, { transition, transitionTime: 1400 });
    } catch (error) {
      // Second attempt with no options at all: an unfamiliar option is a far
      // more likely fault than the sweep itself being unreachable.
      try {
        await mpSdk.Sweep.moveTo(circle.sid);
      } catch (plain) {
        diag.warn(`No travel to ${station.label}: ${String(plain)}`);
      }
      void error;
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


/**
 * The best spot for the guide to stand when a zone is called.
 *
 * Not simply the centre of the rectangle: that is where the products are, and
 * she would end up inside a shelf. Not simply two metres in front of the
 * visitor either, because for a zone the point is that she is standing *at the
 * display* being talked about.
 *
 * So: floor circles near the zone, and of those the one closest to the visitor.
 * Circles are where the capture camera stood, so every candidate is somewhere a
 * person can be; picking the nearest to the viewer means she appears on their
 * side of the display rather than behind it.
 */
export function bestSpotFor(
  area: Area,
  from: { x: number; z: number },
  reach: number,
  floorOffset: number,
): { x: number; y: number; z: number } | null {
  const state = areaState(area.id);
  const candidates = allSweeps().filter((s) => distanceToArea(s, state) <= reach);
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestDistance = Infinity;
  for (const circle of candidates) {
    const distance = Math.hypot(circle.x - from.x, circle.z - from.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = circle;
    }
  }

  // A circle records eye height, so the floor is that minus the capture
  // camera's height above it.
  return { x: best.x, y: best.y - floorOffset, z: best.z };
}


/**
 * Travels to a zone's authored viewpoint, if it has one.
 *
 * Returns false when nothing is authored, so the caller can fall back to
 * guessing. An authored view is a sweep and a heading chosen by someone who
 * could see the room, so it is used exactly rather than being treated as a
 * starting suggestion.
 */
export async function goToAuthoredView(mpSdk: any, state: AreaState): Promise<boolean> {
  if (!state.viewSweep || !mpSdk?.Sweep?.moveTo) return false;

  const transition = mpSdk?.Sweep?.Transition?.FLY ?? 'transition.fly';
  try {
    await mpSdk.Sweep.moveTo(state.viewSweep, { transition, transitionTime: 1400 });
  } catch {
    try {
      await mpSdk.Sweep.moveTo(state.viewSweep);
    } catch (error) {
      diag.warn(`Could not reach the captured view: ${String(error)}`);
      return false;
    }
  }

  try {
    await mpSdk?.Camera?.setRotation?.(
      { x: state.viewPitch ?? 0, y: state.viewYaw ?? 0 },
      { speed: 80 },
    );
  } catch {
    diag.warn('Arrived, but could not turn to the captured heading.');
  }

  return true;
}
