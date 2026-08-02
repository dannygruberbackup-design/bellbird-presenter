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

export type AreaState = {
  /** Where to send a visitor who picks this area. Unset until you place it. */
  position?: { x: number; y: number; z: number };
  /** How far the area reaches from that spot, in metres. */
  radius?: number;
  /** True once a clip has been stored for this area. */
  hasVideo?: boolean;
};

const KEY = 'presenter.areas.v1';

let cache: Record<AreaId, AreaState> = read();

function read(): Record<AreaId, AreaState> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<AreaId, AreaState>) : {};
  } catch {
    return {};
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
  return cache[id] ?? {};
}

export function saveArea(id: AreaId, patch: AreaState): void {
  cache[id] = { ...(cache[id] ?? {}), ...patch };
  persist();
}

export function clearAreas(): void {
  cache = {};
  persist();
}

/** The default reach of an area, in metres, before you tune it. */
export const DEFAULT_AREA_RADIUS = 3;

/** Areas you have actually placed. The rest are not somewhere to send anyone. */
export function placedAreas(): { area: Area; state: AreaState }[] {
  return AREAS.map((area) => ({ area, state: areaState(area.id) })).filter(
    (entry) => entry.state.position,
  );
}

/**
 * The area a point falls inside, or null.
 *
 * Nearest wins where zones overlap, which they do on the plan: Sensory Tiles
 * runs along the edge of Literacy, and Pollination sits inside the STEM end of
 * the room. Picking the nearest centre is not a perfect reading of the map, but
 * it is a predictable one \u2014 and predictable beats clever when a visitor is
 * trying to work out where they are.
 */
export function areaAt(point: { x: number; z: number }): Area | null {
  let best: Area | null = null;
  let bestDistance = Infinity;

  for (const { area, state } of placedAreas()) {
    const p = state.position!;
    const distance = Math.hypot(p.x - point.x, p.z - point.z);
    if (distance > (state.radius ?? DEFAULT_AREA_RADIUS)) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = area;
    }
  }

  return best;
}
