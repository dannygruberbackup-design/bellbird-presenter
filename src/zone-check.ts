// Checking a hand-drawn zone map.
//
// Nineteen rectangles dragged over a plan will contain mistakes, and most of
// them are invisible at the time: a box drawn a few pixels tall, two zones that
// swapped their second corners, a zone drawn outside the building because the
// plan had been panned. None of those look wrong while drawing. All of them
// look wrong to a visitor.
//
// So rather than eyeballing nineteen slabs, the map is measured against what is
// known: the building's own extent, and each zone against its neighbours.

import {
  AREAS,
  aisleReach,
  areaState,
  buildingAngle,
  distanceToArea,
  isPlaced,
  type Area,
  type AreaState,
} from './areas';
import type { Sweep } from './sweeps';

export type Finding = {
  level: 'ok' | 'warn' | 'error';
  text: string;
};

/** Rotates a floor point into the building's frame. */
function local(p: { x: number; z: number }, angle: number) {
  const t = (-angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { x: p.x * cos - p.z * sin, z: p.x * sin + p.z * cos };
}

type Box = { area: Area; minX: number; maxX: number; minZ: number; maxZ: number };

function boxOf(area: Area, state: AreaState, angle: number): Box {
  const a = local(state.cornerA!, angle);
  const b = local(state.cornerB!, angle);
  return {
    area,
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minZ: Math.min(a.z, b.z),
    maxZ: Math.max(a.z, b.z),
  };
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const d = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return w > 0 && d > 0 ? w * d : 0;
}

export function checkZones(sweeps: Sweep[]): Finding[] {
  const angle = buildingAngle();
  const findings: Finding[] = [];

  const placed = AREAS.map((area) => ({ area, state: areaState(area.id) })).filter((e) =>
    isPlaced(e.state),
  );

  const missing = AREAS.filter((area) => !isPlaced(areaState(area.id)));
  findings.push({
    level: missing.length ? 'warn' : 'ok',
    text: `${placed.length} of ${AREAS.length} zones placed.${
      missing.length ? ' Missing: ' + missing.map((a) => a.name).join(', ') : ''
    }`,
  });

  if (placed.length === 0) return findings;

  const boxes = placed.map(({ area, state }) => boxOf(area, state, angle));

  // The sweeps are the building: a zone the visitor can never stand in is a
  // zone drawn somewhere the building is not.
  const hull = sweeps.map((s) => local(s, angle));
  const bounds = hull.length
    ? {
        minX: Math.min(...hull.map((p) => p.x)),
        maxX: Math.max(...hull.map((p) => p.x)),
        minZ: Math.min(...hull.map((p) => p.z)),
        maxZ: Math.max(...hull.map((p) => p.z)),
      }
    : null;

  for (const box of boxes) {
    const width = box.maxX - box.minX;
    const depth = box.maxZ - box.minZ;
    const name = box.area.name;

    if (width < 0.8 || depth < 0.8) {
      findings.push({
        level: 'error',
        text: `${name} is ${width.toFixed(1)} x ${depth.toFixed(1)}m \u2014 too small to stand in.`,
      });
    } else if (width > 25 || depth > 25) {
      findings.push({
        level: 'error',
        text: `${name} is ${width.toFixed(1)} x ${depth.toFixed(1)}m \u2014 larger than the building.`,
      });
    }

    if (bounds) {
      const outside =
        box.maxX < bounds.minX ||
        box.minX > bounds.maxX ||
        box.maxZ < bounds.minZ ||
        box.minZ > bounds.maxZ;
      if (outside) {
        findings.push({ level: 'error', text: `${name} is drawn outside the building.` });
      }
    }

    // What matters is whether a visitor can get near the display, not whether
    // they can stand on it. A zone marks where the products are; the aisle
    // beside it is where anyone actually walks.
    const state = areaState(box.area.id);
    const reachable = sweeps.filter((s) => distanceToArea(s, state) <= aisleReach()).length;
    if (reachable === 0) {
      findings.push({
        level: 'error',
        text: `${name} has no floor circle within ${aisleReach()}m \u2014 unreachable.`,
      });
    } else if (reachable < 3) {
      findings.push({
        level: 'warn',
        text: `${name} has only ${reachable} circle${reachable === 1 ? '' : 's'} within reach.`,
      });
    }
  }

  // Overlap is normal and mostly not worth mentioning: the rectangles mark
  // product footprints, which butt up against each other and nest by design.
  // Only near-identical pairs are reported, because that is two zones sharing a
  // corner by mistake rather than two displays standing side by side.
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const shared = overlapArea(boxes[i], boxes[j]);
      if (shared <= 0) continue;

      const areaI = (boxes[i].maxX - boxes[i].minX) * (boxes[i].maxZ - boxes[i].minZ);
      const areaJ = (boxes[j].maxX - boxes[j].minX) * (boxes[j].maxZ - boxes[j].minZ);
      const worst = shared / Math.min(areaI, areaJ);

      if (worst > 0.9) {
        findings.push({
          level: 'error',
          text: `${boxes[i].area.name} and ${boxes[j].area.name} are almost the same rectangle.`,
        });
      }
    }
  }

  findings.push({ level: 'ok', text: `Building angle ${angle.toFixed(1)}\u00b0.` });
  return findings;
}

/** The whole map as JSON, for handing over or keeping. */
export function exportZones(): string {
  return JSON.stringify(
    {
      buildingAngle: buildingAngle(),
      aisleReach: aisleReach(),
      zones: AREAS.filter((area) => isPlaced(areaState(area.id))).map((area) => ({
        id: area.id,
        name: area.name,
        ...areaState(area.id),
      })),
    },
    null,
    2,
  );
}
