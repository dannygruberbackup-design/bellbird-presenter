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
  /** True once a clip has been stored for this zone. */
  hasVideo?: boolean;
};

type Stored = {
  byArea: Record<AreaId, AreaState>;
  /** How far the building is turned from Matterport's world axes, in degrees. */
  buildingAngle?: number;
  /** How far from a display still counts as being at it, in metres. */
  aisleReach?: number;
};

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

export function areaState(id: AreaId): AreaState {
  return cache.byArea[id] ?? {};
}

export function saveArea(id: AreaId, patch: AreaState): void {
  cache.byArea[id] = { ...(cache.byArea[id] ?? {}), ...patch };
  persist();
}

export function buildingAngle(): number {
  return cache.buildingAngle ?? 0;
}

export function setBuildingAngle(degrees: number): void {
  cache.buildingAngle = degrees;
  persist();
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

/** How far from a display still counts as being at it, in metres. */
export function aisleReach(): number {
  return cache.aisleReach ?? 2;
}

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
export function areasAt(point: { x: number; z: number }): Area[] {
  return placedAreas()
    .map(({ area, state }) => ({ area, distance: distanceToArea(point, state) }))
    .filter((entry) => entry.distance <= aisleReach())
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.area);
}
