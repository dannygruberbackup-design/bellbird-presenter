// The showroom's zones, from the floor plan.
//
// This is the change the zone map forces, and it is worth stating plainly: an
// area is not a presenter.
//
// Until now each guide *was* a place — spawn four presenters, get four stops.
// Nineteen zones cannot work that way. Nineteen presenter instances means
// nineteen video elements, nineteen chroma planes and nineteen scene nodes,
// almost all of them idle, on an iPad.
//
// So an area is data: a name, a spot to travel to, how far its edge reaches,
// and which clip belongs to it. A presenter is one renderer that gets moved to
// wherever the visitor is and handed the clip for the area they asked about.
// One person, many places, which is also how a real guide works.

export type AreaId = string;

export type Area = {
  id: AreaId;
  name: string;
};

/**
 * Zone names exactly as they appear on the showroom map.
 *
 * Order follows the plan roughly front-to-back, so the menu reads like a walk
 * through the building rather than an alphabetical list of nouns.
 */
export const AREAS: Area[] = [
  { id: 'reception', name: 'Reception Area' },
  { id: 'infants', name: 'Infants (0\u201312mths)' },
  { id: 'toddlers', name: 'Toddlers (12mths\u20132yrs)' },
  { id: 'music', name: 'Music' },
  { id: 'art', name: 'Art Space' },
  { id: 'nesting', name: 'Nesting Tables' },
  { id: 'construction', name: 'Construction' },
  { id: 'sensory-tiles', name: 'Sensory Tiles' },
  { id: 'literacy', name: 'Literacy' },
  { id: 'meeting', name: 'Meeting Table' },
  { id: 'indigenous', name: 'Indigenous Resources' },
  { id: 'dream-house', name: 'Dream House' },
  { id: 'dinosaur', name: 'Dinosaur Discovery' },
  { id: 'stem', name: 'STEM' },
  { id: 'pollination', name: 'Pollination Station' },
  { id: 'sensory-corner', name: 'Sensory Corner' },
  { id: 'retreats', name: 'Retreats' },
  { id: 'pretend-play', name: 'Pretend Play' },
  { id: 'sleep', name: 'Sleep Space' },
];

export type Point = { x: number; y: number; z: number };

export type AreaState = {
  /** Opposite corners of the zone, in world space. Both needed to be placed. */
  cornerA?: Point;
  cornerB?: Point;
  /** True once a clip has been stored on this device for this zone. */
  hasVideo?: boolean;

  /**
   * A hosted clip for this zone, served with the site.
   *
   * The uploaded copy is for authoring: it lives in this browser and no visitor
   * will ever see it. A published tour needs its videos on a URL like any other
   * asset, so this is what a visitor plays and the upload is what you preview.
   */
  videoUrl?: string;

  // The authored viewpoint: which circle to stand on and which way to look.
  //
  // Worth the setup time. Choosing the nearest circle and aiming at the middle
  // of the rectangle is a decent guess and will never be better than a guess:
  // it does not know that the display reads best from the left, or that the
  // obvious circle puts a pillar in the way. Nineteen judgements made once beat
  // a rule applied nineteen times.
  viewSweep?: string;
  viewYaw?: number;
  viewPitch?: number;

  /** Where the guide stands for this zone. */
  guideAt?: Point;
};

type Stored = {
  byArea: Record<AreaId, AreaState>;
  /** How far the building is turned from Matterport's world axes, in degrees. */
  buildingAngle?: number;
  /** How far from a display still counts as being at it, in metres. */
  aisleReach?: number;
};

import { PUBLISHED } from './areas.published';

const KEY = 'presenter.areas.v2';

let cache: Stored = read();

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Stored) : null;
    return parsed?.byArea ? parsed : { byArea: {} };
  } catch {
    return { byArea: {} };
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private browsing; the session still works, it just will not persist */
  }
}

/**
 * A zone's placement: what you have drawn here, or what shipped with the build.
 *
 * Local first so authoring is immediate, published underneath so a browser that
 * has never drawn anything still knows where the zones are. Merged rather than
 * chosen between, so redrawing a rectangle does not silently discard the
 * captured view that came with it.
 */
export function areaState(id: AreaId): AreaState {
  return { ...(PUBLISHED.byArea[id] ?? {}), ...(cache.byArea[id] ?? {}) };
}

export function saveArea(id: AreaId, patch: AreaState): void {
  cache.byArea[id] = { ...(cache.byArea[id] ?? {}), ...patch };
  persist();
}

export function buildingAngle(): number {
  return cache.buildingAngle ?? PUBLISHED.buildingAngle ?? 0;
}

export function setBuildingAngle(degrees: number): void {
  cache.buildingAngle = degrees;
  persist();
}

/** Zones that have a clip stored against them. */
export function hasClip(id: AreaId): boolean {
  return Boolean(areaState(id).hasVideo);
}

export function clearAreas(): void {
  cache = { byArea: {} };
  persist();
}

/** A zone is placed once both its corners are known. */
export function isPlaced(state: AreaState): boolean {
  return Boolean(state.cornerA && state.cornerB);
}

/** Areas you have actually placed. The rest are not somewhere to send anyone. */
/** Replaces everything drawn here with a map exported from another browser. */
export function importMap(json: string): number {
  const parsed = JSON.parse(json) as {
    buildingAngle?: number;
    aisleReach?: number;
    zones?: ({ id: AreaId } & AreaState)[];
    byArea?: Record<AreaId, AreaState>;
  };

  const byArea: Record<AreaId, AreaState> = {};
  if (parsed.byArea) Object.assign(byArea, parsed.byArea);
  for (const zone of parsed.zones ?? []) {
    const { id, ...rest } = zone;
    byArea[id] = rest;
  }

  cache = {
    byArea,
    buildingAngle: parsed.buildingAngle,
    aisleReach: parsed.aisleReach,
  };
  persist();
  return Object.keys(byArea).length;
}

export function placedAreas(): { area: Area; state: AreaState }[] {
  return AREAS.map((area) => ({ area, state: areaState(area.id) })).filter((entry) =>
    isPlaced(entry.state),
  );
}

/** Rotates a floor point into the building's own frame. */
function intoBuildingFrame(p: { x: number; z: number }): { x: number; z: number } {
  const t = (-buildingAngle() * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { x: p.x * cos - p.z * sin, z: p.x * sin + p.z * cos };
}

/** The middle of a zone, in world space \u2014 where a visitor is sent. */
export function areaCentre(state: AreaState): Point | null {
  if (!isPlaced(state)) return null;
  const a = state.cornerA!;
  const b = state.cornerB!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/**
 * How far a point is from a zone's rectangle. Zero when inside it.
 *
 * Distance rather than inside-or-out, because a zone marks where the *products*
 * are, not where anyone walks. The visitor stands in the aisle beside a display,
 * which is outside every rectangle on the plan — so an inside test reports them
 * as being nowhere, in the middle of a showroom.
 */
export function distanceToArea(point: { x: number; z: number }, state: AreaState): number {
  if (!isPlaced(state)) return Infinity;

  const here = intoBuildingFrame(point);
  const a = intoBuildingFrame(state.cornerA!);
  const b = intoBuildingFrame(state.cornerB!);

  const dx = Math.max(Math.min(a.x, b.x) - here.x, 0, here.x - Math.max(a.x, b.x));
  const dz = Math.max(Math.min(a.z, b.z) - here.z, 0, here.z - Math.max(a.z, b.z));
  return Math.hypot(dx, dz);
}

/**
 * Extra apparent distance for a zone you have your back to.
 *
 * Standing in an aisle you are equally close to the displays on both sides, but
 * you are only looking at one of them. Position alone cannot tell those apart,
 * and the answer a visitor wants is the thing in front of them.
 *
 * Expressed as distance rather than a hard cone so it degrades gracefully: a
 * display slightly off to one side is slightly less likely to be what you mean,
 * not suddenly invisible. A zone you are practically touching still counts
 * whichever way you face, because at half a metre you are at it regardless.
 */
function facingPenalty(
  point: { x: number; z: number },
  state: AreaState,
  yaw?: number | null,
): number {
  if (yaw === undefined || yaw === null) return 0;
  if (!isPlaced(state)) return 0;

  const centre = areaCentre(state)!;
  const dx = centre.x - point.x;
  const dz = centre.z - point.z;
  if (Math.hypot(dx, dz) < 0.6) return 0;

  // A camera looks down its own -Z, so a yaw of t points it along
  // (-sin t, -cos t).
  const t = (yaw * Math.PI) / 180;
  const facing = { x: -Math.sin(t), z: -Math.cos(t) };
  const length = Math.hypot(dx, dz);
  const dot = (facing.x * dx + facing.z * dz) / length;

  // 0 dead ahead, rising to 2.5m directly behind.
  return (1 - dot) * 1.25;
}

/** How far from a display still counts as being at it, in metres. */
export function aisleReach(): number {
  return cache.aisleReach ?? PUBLISHED.aisleReach ?? 1.5;
}

/**
 * How much further than the nearest display still counts as being there too.
 *
 * An absolute reach alone is not enough. Standing in an open aisle by the front
 * door, five displays sit within two metres and all five light up, which tells
 * a visitor nothing they did not already know. What they mean by "here" is the
 * thing they are next to, plus anything genuinely alongside it — not everything
 * in the room that happens to be within arm's reach of the aisle.
 *
 * So a zone lights only if it is within reach AND within this margin of the
 * closest one. Stand at a display and it alone lights; stand between two and
 * both do.
 */
const COMPANION_MARGIN = 0.9;

export function setAisleReach(metres: number): void {
  cache.aisleReach = metres;
  persist();
}

/**
 * Every zone within reach, nearest first — plural, deliberately.
 *
 * Overlap is expected, and so is being near several displays at once: the plan
 * nests zones, and an aisle can run between three of them. Picking one winner
 * would be the app guessing which the visitor meant. Ordering by distance puts
 * the likeliest first without hiding the rest.
 */
export function areasAt(point: { x: number; z: number }, yaw?: number | null): Area[] {
  const within = placedAreas()
    .map(({ area, state }) => ({
      area,
      distance: distanceToArea(point, state) + facingPenalty(point, state, yaw),
    }))
    .filter((entry) => entry.distance <= aisleReach())
    .sort((a, b) => a.distance - b.distance);

  if (within.length === 0) return [];

  const nearest = within[0].distance;
  return within
    .filter((entry) => entry.distance <= nearest + COMPANION_MARGIN)
    .map((entry) => entry.area);
}

/**
 * Where the guide should stand to talk about a zone.
 *
 * Not two metres in front of the visitor, which is where she used to appear:
 * that puts her wherever the visitor happens to be looking, sometimes with the
 * display behind her back. She belongs *at* the thing she is describing.
 *
 * Among the circles near the zone, the best is the one about two metres from
 * the visitor \u2014 close enough to talk, far enough to see her whole \u2014 with a
 * gentle preference for standing nearer the display than they are, so she has
 * it behind her rather than between them.
 */
export function bestSpotFor(
  state: AreaState,
  viewer: { x: number; z: number },
  circles: { x: number; y: number; z: number }[],
): { x: number; y: number; z: number } | null {
  if (!isPlaced(state)) return null;

  const candidates = circles.filter((c) => distanceToArea(c, state) <= aisleReach());
  if (candidates.length === 0) return null;

  let best: { x: number; y: number; z: number } | null = null;
  let bestScore = Infinity;

  for (const c of candidates) {
    const fromViewer = Math.hypot(c.x - viewer.x, c.z - viewer.z);
    // Standing on top of the visitor is worse than standing slightly too far.
    if (fromViewer < 1.1) continue;

    const score = Math.abs(fromViewer - 2) + distanceToArea(c, state) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}
