import { diag } from './diagnostics';

// Remembers how each presenter was set up, so a session picks up where the last
// one stopped.
//
// Keyed per presenter, because the whole point of several guides is that they
// stand in different rooms at different sizes. A single shared record would
// have presenter 2 inherit presenter 1's position the moment you switched.
//
// localStorage rather than IndexedDB: a few dozen bytes of numbers that must be
// readable synchronously at startup. Videos are far too big for it and live in
// IndexedDB instead — see video-store.ts.
//
// Still device-local. A convenience for authoring, not a substitute for writing
// the final numbers into presenters.config.ts, which is what visitors see.

const KEY = 'presenter.settings.v2';

export type PresenterSettings = {
  position?: { x: number; y: number; z: number };
  /** The presenter's own height in metres, not the video frame's. */
  personHeight?: number;
  shadowDiameter?: number;
  shadowOpacity?: number;
  billboardMode?: 'yaw' | 'full';
  /** Seconds trimmed off the front of the clip. */
  startAt?: number;
  /** How far in front of the viewer she appears when summoned. */
  summonDistance?: number;
  /** What to call this one in the panel. */
  name?: string;
  /** Fraction of the source frame width kept, centred. */
  frameWidth?: number;
  cropTop?: number;
  cropBottom?: number;
  /** Vertical nudge from the floor, in metres. */
  groundOffset?: number;
  brightness?: number;
  mode?: 'always' | 'onApproach';
  beaconStyle?: 'spin' | 'static' | 'off';
  beaconSize?: number;
  beaconHeight?: number;
  beaconSpeed?: number;
  signText?: string;
  signSize?: number;
  signFont?: number;
  signShape?: 'rect' | 'rounded' | 'pill';
  beaconTurn?: number;
  beaconTilt?: number;
  beaconRoll?: number;
  triggerRadius?: number;
  visible?: boolean;
};

export type AllSettings = {
  byPresenter: Record<string, PresenterSettings>;
  /**
   * Camera height above the floor, in metres.
   *
   * Shared rather than per-presenter: it is a property of how the space was
   * captured, not of any one guide. A sweep records where the capture camera
   * stood, which is eye level; subtracting this gives the floor.
   */
  floorOffset?: number;
  snapToCircles?: boolean;
  selected?: string;
};

let cache: AllSettings = read();

function read(): AllSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as AllSettings) : null;
    return parsed?.byPresenter ? parsed : { byPresenter: {} };
  } catch {
    return { byPresenter: {} };
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private browsing; the session still works, it just will not persist */
  }
}

export function loadGlobal(): AllSettings {
  return cache;
}

export function saveGlobal(patch: Partial<AllSettings>): void {
  cache = { ...cache, ...patch };
  persist();
}

export function loadFor(id: string): PresenterSettings {
  return cache.byPresenter[id] ?? {};
}

export function saveFor(id: string, patch: PresenterSettings): void {
  cache.byPresenter[id] = { ...(cache.byPresenter[id] ?? {}), ...patch };
  persist();
}

export function clearSettings(): void {
  cache = { byPresenter: {} };
  try {
    localStorage.removeItem(KEY);
    diag.info('Saved settings cleared. Reload to return to the defaults.');
  } catch {
    /* nothing stored */
  }
}
