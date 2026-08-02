import type { PresenterHandle } from './scene';
import { nearestSweep } from './sweeps';
import { diag } from './diagnostics';

// Turns the placed presenters into a list a visitor can travel between.
//
// Each placed guide is a station: somewhere worth standing, with something to
// say. The menu, the walkthrough and the beacons are three ways into the same
// list rather than three features — which is why they share this module instead
// of each growing their own idea of what a station is.

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

/**
 * Moves the viewer to a station, then starts her talking.
 *
 * Travel first, speak second. Starting the clip before the camera arrives means
 * a visitor hears the opening line while still looking at the last room, which
 * reads as a glitch rather than a greeting.
 */
export async function goToStation(
  mpSdk: any,
  station: Station,
  onArrived: () => void,
): Promise<void> {
  const position = station.handle.getPosition();
  const circle = nearestSweep(position, 6);

  if (circle?.sid && mpSdk?.Sweep?.moveTo) {
    try {
      await mpSdk.Sweep.moveTo(circle.sid, { transition: 'fly', transitionTime: 1400 });
    } catch (error) {
      // A failed move is not a reason to stay silent; she can still speak from
      // wherever the visitor happens to be.
      diag.warn(`Could not travel to ${station.label}: ${String(error)}`);
    }
  } else {
    diag.warn(`No reachable circle near ${station.label}; playing from here.`);
  }

  onArrived();
}
