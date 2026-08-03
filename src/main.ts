// Must come first: it pre-sets window.THREE so the web component does not
// install a null-prototype namespace that breaks every addComponent call.
import './three-global';
import '@matterport/webcomponent';
import './ui.css';

import { spawnPresenters, spawnZoneOverlay, type PresenterHandle } from './scene';
import { PUBLISHED_CLIP_IDS } from './areas.published';
import { publish, publishKey, setPublishKey } from './publish';
import { createDirector } from './presenter-director';
import { createCaptionController } from './captions';
import { createPlacementMode } from './placement';
import { PRESENTERS, DIRECTOR_OPTIONS } from './presenters.config';
import { SDK_KEY, MODEL_SID, IS_DEV, SHOW_DIAG, WANT_LIGHTS } from './config';
import { initDiagnostics, diag, describeError } from './diagnostics';
import { connectSdk } from './connect';
import { saveVideo, loadVideo, clearVideo } from './video-store';
import { subscribeSweeps, nearestSweep, allSweeps } from './sweeps';
import { calibrate, type ScreenToWorld } from './plan-mapping';
import { checkZones, exportZones } from './zone-check';
import { goToStation, lookAt, bestSpotFor, goToAuthoredView } from './stations';
import type { ZoneOverlayComponent } from './zone-overlay';
import {
  AREAS,
  areasAt,
  areaState,
  areaCentre,
  saveArea,
  placedAreas,
  isPlaced,
  buildingAngle,
  setBuildingAngle,
  aisleReach,
  setAisleReach,
  importMap,
  clipUrlFor,
  type Area,
} from './areas';
import { loadFor, saveFor, loadGlobal, saveGlobal, clearSettings } from './settings-store';

const viewer = document.querySelector('matterport-viewer') as any;
const startPanel = document.querySelector('#start-panel') as HTMLElement;
const startButton = document.querySelector('#start') as HTMLButtonElement;
const captionRegion = document.querySelector('#captions') as HTMLElement;
const captionToggle = document.querySelector('#caption-toggle') as HTMLButtonElement;
const soundToggle = document.querySelector('#sound-toggle') as HTMLButtonElement;
const devPanel = document.querySelector('#dev-panel') as HTMLElement;
const devReadout = document.querySelector('#dev-readout') as HTMLElement;

// The plane is sized in frame heights, but the number a person wants to set is
// how tall the presenter is. Measured from the supplied footage she occupies
// 923px of a 944px crop, so the frame is 2.3% taller than she is.
/** Camera height above the floor when the space was captured. */
const DEFAULT_FLOOR_OFFSET = 1.5;

const DEFAULT_SUMMON_DISTANCE = 2;

/** Which presenter every control acts on. */
let selected = 0;
let handles: PresenterHandle[] = [];

const current = (): PresenterHandle | null => handles[selected] ?? null;

async function stage<T>(label: string, work: () => Promise<T> | T): Promise<T> {
  diag.info(`${label}...`);
  try {
    const result = await work();
    diag.info(`${label}: ok`);
    return result;
  } catch (error) {
    diag.error(`${label} FAILED. ${describeError(error)}`);
    throw error;
  }
}

async function main() {
  initDiagnostics(SHOW_DIAG);

  //
  // The window.THREE workaround in three-global.ts only works if it runs before
  // the web component's module body. As separate source files that is
  // guaranteed: module bodies execute in import order. Bundled into one file it
  // is not — ES imports hoist above every statement, so a static
  // `import '@matterport/webcomponent'` would run first no matter where it sits
  // in the text, and every addComponent call would throw
  // "t.hasOwnProperty is not a function" again.
  //
  // A dynamic import is an ordinary statement, so it waits its turn.
  diag.info(`Space ${MODEL_SID}, key ends ...${SDK_KEY.slice(-4)}`);

  viewer.setAttribute('m', MODEL_SID);
  viewer.setAttribute('application-key', SDK_KEY);

  const mpSdk = await stage('Connecting to the viewer', () => connectSdk(viewer));
  subscribeSweeps(mpSdk);
  mpSdk?.Camera?.pose?.subscribe?.((pose: any) => {
    lastPose = pose;
  });

  handles = await stage('Placing the presenters', () =>
    spawnPresenters(mpSdk, PRESENTERS, WANT_LIGHTS),
  );

  const captions = createCaptionController(captionRegion);

  const director = createDirector(
    handles.map((h) => ({ id: h.id, component: h.component, options: h.director })),
    captions,
    DIRECTOR_OPTIONS,
  );

  applySavedSettings();

  director.start();
  wireControls(mpSdk, director, captions);
  wireStations(mpSdk, director);
  await restoreSavedVideos();
  diag.info('Ready.');

  if (IS_DEV) void enableDevTools(mpSdk, director);
}

// ---------------------------------------------------------------- summoning

/**
 * Moves a guide to a spot in front of the viewer and starts her talking.
 *
 * The ideal point is a straight line from where you stand, but a straight line
 * lands wherever it lands — inside a bookcase, on a table, through a wall. So
 * the ideal point is snapped to the nearest floor circle, which is walkable by
 * definition, and her height comes from that circle's own height minus the
 * capture camera's eye height. That is what keeps her feet on the floor on any
 * storey rather than at whatever height she happened to be before.
 */
function summon(director: ReturnType<typeof createDirector>, mpSdk?: any) {
  const handle = current();
  if (!handle) return;

  const global = loadGlobal();
  const mine = loadFor(handle.id);
  const distance = mine.summonDistance ?? DEFAULT_SUMMON_DISTANCE;
  const floorOffset = global.floorOffset ?? DEFAULT_FLOOR_OFFSET;

  const ideal = handle.component.pointInFrontOfViewer(distance);
  if (!ideal) {
    // Without a viewer position and facing there is no "in front of"; play
    // where she stands rather than moving her somewhere arbitrary.
    diag.warn('Cannot tell which way you are facing, so playing where she stands.');
    director.unmute();
    director.replay(handle.id);
    return;
  }

  // Reach a little past the summon distance: at 2m the nearest circle may well
  // be 2.5m away, and standing slightly off the mark beats standing in a chair.
  const circle = nearestSweep(ideal, Math.max(2.5, distance));
  const target = circle
    ? { x: circle.x, y: circle.y - floorOffset, z: circle.z }
    : ideal;

  handle.component.setVisible(true);
  handle.setPosition(target);
  saveFor(handle.id, { position: target, visible: true });

  diag.info(
    circle
      ? `${handle.id}: on a floor circle ${distance}m ahead.`
      : `${handle.id}: no circle within reach, placed ${distance}m ahead as-is.`,
  );

  director.unmute();
  director.replay(handle.id);

  // Turn to face her. Asking for the guide while looking at a wall otherwise
  // leaves her politely behind your shoulder, which reads as nothing happening.
  const from = handle.component.viewerPosition();
  if (mpSdk && from) void lookAt(mpSdk, target, from);
}

// ---------------------------------------------------------------- restoring

function applySavedSettings() {
  for (const handle of handles) {
    const saved = loadFor(handle.id);
    if (Object.keys(saved).length === 0) continue;

    if (saved.position) handle.setPosition(saved.position);
    if (saved.personHeight) {
      handle.component.setHeightMeters(saved.personHeight);
    }
    if (saved.shadowDiameter !== undefined && saved.shadowOpacity !== undefined) {
      handle.component.setShadow(saved.shadowDiameter, saved.shadowOpacity);
    }
    if (saved.billboardMode) handle.component.setBillboardMode(saved.billboardMode);
    if (saved.startAt !== undefined) handle.component.setStartAt(saved.startAt);
    if (saved.visible !== undefined) handle.component.setVisible(saved.visible);
    if (saved.brightness !== undefined) handle.component.setBrightness(saved.brightness);
    if (saved.mode) handle.component.setMode(saved.mode);
    if (saved.triggerRadius !== undefined) {
      handle.component.setTriggerRadius(saved.triggerRadius);
    }
    applyFraming(handle, saved);
  }

  const chosen = loadGlobal().selected;
  const index = handles.findIndex((h) => h.id === chosen);
  if (index >= 0) selected = index;
}

// Frame width is expressed as "how much of the source is kept", centred,
// because the subject sits in the middle of a generated plate. Trims are per
// edge because feet and headroom are never symmetric.
/**
 * Clears the framing when a new clip is loaded.
 *
 * Framing belongs to a clip, not to the slot that plays it. Trimming a
 * landscape frame down to a third to find the presenter is right for that file
 * and nonsense for the next one - and it applies silently, so a properly framed
 * vertical clip arrives already cut to a third of its width with nothing on
 * screen to say why.
 *
 * Height is deliberately left alone: that is how tall she is in the room, which
 * does not change because the file did.
 */
function resetFramingFor(handle: PresenterHandle): void {
  saveFor(handle.id, { frameWidth: 1, cropTop: 0, cropBottom: 0, groundOffset: 0 });
  handle.component.setCrop(0, 0, 0, 0);
  handle.component.setGroundOffset(0);

  // The sliders have to follow, or they show a third of a frame while the
  // presenter shows all of it, and the next drag snaps back to the stale value.
  setSlider('#frame-width', '#frame-width-value', 1, pct);
  setSlider('#crop-top', '#crop-top-value', 0, pct);
  setSlider('#crop-bottom', '#crop-bottom-value', 0, pct);
  setSlider('#ground-offset', '#ground-offset-value', 0, (v) => `${v.toFixed(2)} m`);
  diag.info('Framing reset for the new clip.');
}

function applyFraming(handle: PresenterHandle, saved: ReturnType<typeof loadFor>) {
  const kept = saved.frameWidth ?? 1;
  const side = (1 - kept) / 2;
  handle.component.setCrop(side, side, saved.cropTop ?? 0, saved.cropBottom ?? 0);
  handle.component.setGroundOffset(saved.groundOffset ?? 0);
}

function displayName(handle: PresenterHandle): string {
  return loadFor(handle.id).name?.trim() || handle.id;
}

async function restoreSavedVideos() {
  for (const handle of handles) {
    const saved = await loadVideo(handle.id);
    if (!saved) continue;
    handle.component.useVideo(URL.createObjectURL(saved.blob), saved.name);
    diag.info(`${handle.id}: restored ${saved.name} (${saved.sizeMb.toFixed(1)} MB).`);
  }
}

// ---------------------------------------------------------------- visitor UI

function wireControls(
  mpSdk: any,
  director: ReturnType<typeof createDirector>,
  captions: ReturnType<typeof createCaptionController>,
) {
  let soundOn = false;

  const setSound = (on: boolean) => {
    soundOn = on;
    if (on) director.unmute();
    else director.mute();
    soundToggle.setAttribute('aria-pressed', String(on));
    soundToggle.textContent = on ? 'Sound on' : 'Sound off';
  };

  const setCaptions = (on: boolean) => {
    captions.setEnabled(on);
    captionToggle.setAttribute('aria-pressed', String(on));
    captionToggle.textContent = on ? 'Captions on' : 'Captions off';
  };

  // Browsers block audio until a real user gesture, so the summon doubles as
  // the unlock: it is a real tap, and it is the moment the visitor has asked
  // to be spoken to.
  startButton.addEventListener('click', () => {
    setSound(true);
    summon(director, mpSdk);
    startPanel.hidden = true;
  });

  // Pause and Hide act on whoever is speaking, or on every guide if none is.
  // A visitor does not know which presenter is "selected"; they know they want
  // quiet, or they want the room to themselves.
  const pauseButton = document.querySelector('#pause-toggle') as HTMLButtonElement;
  let paused = false;
  pauseButton.addEventListener('click', () => {
    paused = !paused;
    for (const handle of handles) {
      if (paused) handle.component.pause();
      else if (handle.component.inputs.visible) void handle.component.play(soundOn ? false : true);
    }
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.setAttribute('aria-pressed', String(paused));
  });

  const hideButton = document.querySelector('#hide-toggle') as HTMLButtonElement;
  let hidden = false;
  hideButton.addEventListener('click', () => {
    hidden = !hidden;
    for (const handle of handles) {
      if (hidden) handle.component.pause();
      handle.component.setVisible(hidden ? false : (loadFor(handle.id).visible ?? true));
    }
    hideButton.textContent = hidden ? 'Show guide' : 'Hide guide';
    hideButton.setAttribute('aria-pressed', String(hidden));
  });

  soundToggle.addEventListener('click', () => setSound(!soundOn));
  captionToggle.addEventListener('click', () => setCaptions(!captions.enabled));

  setCaptions(captions.enabled);

  // Sound on from the start. Browsers still block audio until a real gesture,
  // so the first clip may open silent — but the intent is recorded, and every
  // later play has sound without anyone hunting for a toggle. Starting muted
  // meant a guide who mouthed her welcome to a visitor who never realised
  // there was audio at all.
  setSound(true);
  startPanel.hidden = false;
}

// The menu, the walkthrough and proximity are three doors into the same list
// of stations. Built fresh each time it opens, because a guide can be placed or
// hidden at any moment and a stale menu that sends someone nowhere is worse
// than no menu.
function wireStations(mpSdk: any, director: ReturnType<typeof createDirector>) {
  const panel = document.querySelector('#stations') as HTMLElement;
  const toggle = document.querySelector('#stations-toggle') as HTMLButtonElement;
  const list = document.querySelector('#station-list') as HTMLElement;
  const walkButton = document.querySelector('#walkthrough') as HTMLButtonElement;
  if (!panel || !toggle || !list) return;

  let rows: { area: Area; li: HTMLElement; play: HTMLButtonElement }[] = [];
  const hereNow = document.querySelector('#here-now') as HTMLElement;
  const ambient = new Map<string, HTMLElement>();

  const close = () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  const travel = async (area: Area) => {
    const state = areaState(area.id);
    const centre = areaCentre(state);
    if (!centre) {
      diag.warn(`${area.name} has no position.`);
      return;
    }
    close();

    // An authored view wins outright. Everything below it is the fallback for
    // zones nobody has framed yet.
    if (await goToAuthoredView(mpSdk, state)) return;

    await goToStation(
      mpSdk,
      { handle: handles[0], label: area.name },
      () => {
        // Arriving is only half of it: the sweep nearest a zone is often beside
        // or behind the display, so landing without turning leaves you looking
        // at whatever the last camera angle happened to be - which, having just
        // asked to be taken to Music, is not Music.
        //
        // Deliberately not awaited, so the turn overlaps the tail of the move
        // rather than beginning once it has stopped.
        const from = handles[0]?.component.viewerPosition();
        if (from) void lookAt(mpSdk, centre, from);
      },
      centre,
    );
  };

  // Travel then speak, in one tap. The two-step is still there for anyone
  // browsing — tap the name, look around, tap the guide when ready — but
  // someone who already knows what they want should not have to tap twice for
  // the same outcome.
  const call = async (area: Area) => {
    const state = areaState(area.id);
    const centre = areaCentre(state);
    if (!centre) return;
    close();

    // Same viewpoint as travelling there, then she appears in it.
    if (await goToAuthoredView(mpSdk, state)) {
      await useAreaClip(area);
      const handle = handles[0];
      const from = handle?.component.viewerPosition();
      const spot =
        state.guideAt ??
        (from ? bestSpotFor(area, from, aisleReach(), loadGlobal().floorOffset ?? DEFAULT_FLOOR_OFFSET) : null);
      if (handle && spot) {
        handle.component.setVisible(true);
        handle.setPosition(spot);
        saveFor(handle.id, { position: spot, visible: true });
      }
      director.unmute();
      director.replay(handles[0].id);
      return;
    }

    await goToStation(
      mpSdk,
      { handle: handles[0], label: area.name },
      async () => {
        await useAreaClip(area);

        const handle = handles[0];
        const from = handle?.component.viewerPosition();
        if (!handle || !from) return;

        // She stands at the display being talked about, not a fixed distance in
        // front of whoever asked. The zone is the subject; putting her two
        // metres from the visitor would have her describing a shelf she has her
        // back to.
        const floorOffset = loadGlobal().floorOffset ?? DEFAULT_FLOOR_OFFSET;
        const spot = state.guideAt ?? bestSpotFor(area, from, aisleReach(), floorOffset);
        if (spot) {
          handle.component.setVisible(true);
          handle.setPosition(spot);
          saveFor(handle.id, { position: spot, visible: true });
          void lookAt(mpSdk, spot, from);
        }

        director.unmute();
        director.replay(handle.id);
      },
      centre,
    );
  };

  // Built once, then only its classes change. Rebuilding the list on every
  // repaint would restart the transitions four times a second, so nothing would
  // ever finish easing in.
  // The full list, built once and only re-marked afterwards.
  const build = () => {
    if (rows.length) return;
    list.textContent = '';
    rows = placedAreas().map(({ area }) => {
      const li = document.createElement('li');

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      go.textContent = area.name;
      // Works whether or not you are standing there: picking a zone you can see
      // across the room is a perfectly ordinary thing to want.
      go.addEventListener('click', () => void travel(area));

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'call';
      play.textContent = '\u25b6';
      play.title = `Bring the guide to ${area.name}`;
      play.setAttribute('aria-label', play.title);
      play.disabled = !hasAnyClip(area.id);
      play.addEventListener('click', () => void call(area));

      li.append(go, play);
      list.appendChild(li);
      return { area, li, play };
    });
  };

  /**
   * The ambient view: the zones you are in, as text at the edge of the screen.
   *
   * Rows are added and removed rather than shown and hidden, so a zone you walk
   * out of eases away and its replacement eases in behind it. Kept between
   * repaints by id, because rebuilding the lot four times a second would mean
   * nothing ever finished fading.
   */
  const showHere = (here: Area[]) => {
    const wanted = new Set(here.map((a) => a.id));

    for (const [id, line] of ambient) {
      if (wanted.has(id)) continue;
      ambient.delete(id);
      line.classList.remove('show');
      // Removed only once the fade has run; taking it out immediately would
      // make it vanish rather than leave.
      window.setTimeout(() => line.remove(), 450);
    }

    here.forEach((area, index) => {
      let line = ambient.get(area.id);
      if (!line) {
        line = document.createElement('div');
        line.className = 'line';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = area.name;

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'play';
        play.textContent = '\u25b6';
        play.title = `Bring the guide to ${area.name}`;
        play.setAttribute('aria-label', play.title);
        play.disabled = !hasAnyClip(area.id);
        play.addEventListener('click', () => void call(area));

        line.append(name, play);
        hereNow.appendChild(line);
        ambient.set(area.id, line);

        // A frame's delay so the browser has the starting state to animate from.
        requestAnimationFrame(() => line!.classList.add('show'));
      }
      line.style.order = String(index);
    });
  };

  /** Marks the zones you are in within the full list. */
  const paint = () => {
    const from = handles[0]?.component.viewerPosition();
    const here = from ? areasAt(from, lastPose?.rotation?.y) : [];
    const ids = here.map((a) => a.id);

    for (const row of rows) {
      row.li.classList.toggle('here', ids.includes(row.area.id));
      row.play.classList.toggle('ready', ids.includes(row.area.id));
    }

    // The ambient view stands down while the full list is open: two answers to
    // the same question, one over the top of the other, is just noise.
    hereNow.hidden = !panel.hidden;
    if (panel.hidden) showHere(here);
    else showHere([]);

    toggle.textContent = here[0]?.name ?? 'Areas';
    toggle.classList.toggle('here', here.length > 0);
  };

  // Always running: the ambient view is the default state of the interface, not
  // something the menu switches on.
  window.setInterval(paint, 250);

  toggle.addEventListener('click', () => {
    const opening = panel.hidden;
    if (opening) build();
    panel.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    paint();
  });

  walkButton?.addEventListener('click', async () => {
    const stops = placedAreas();
    if (stops.length === 0) return;
    close();
    diag.info(`Walkthrough: ${stops.length} zones.`);
    for (const { area } of stops) {
      await call(area);
      await waitForClip(handles[0]);
    }
    diag.info('Walkthrough finished.');
  });
}

/**
 * Stands the guide at the display, then turns the visitor to face her.
 *
 * Falls back to appearing in front of the visitor when the zone has no circle
 * of its own within reach \u2014 better a guide slightly out of place than a play
 * button that silently does nothing.
 */

/**
 * Hands the guide the clip that belongs to this zone.
 *
 * One renderer, many zones: she is not nineteen people, she is one surface that
 * plays whichever recording the place calls for.
 */
async function useAreaClip(area: Area): Promise<void> {
  const handle = handles[0];
  if (!handle) return;
  if (lastClip === area.id) return;

  // A clip uploaded here wins, because that is what you are previewing. Failing
  // that, the hosted one, which is the only version a visitor can ever play.
  const saved = await loadVideo(`area:${area.id}`);
  const source = saved ? URL.createObjectURL(saved.blob) : clipUrlFor(area.id);
  handle.component.useVideo(source, area.name);
  lastClip = area.id;
}

/** Preserved verbatim when the map is republished from the browser. */
const PUBLISHED_HEADER = `// Zone placements that ship with the build.
//
// Generated by Publish zone map in the author panel. Authoring writes to
// browser storage, which is right while drawing and wrong as the finished
// article: storage belongs to one browser on one machine, and the version that
// matters is the visitor's.

import type { AreaId, AreaState } from './areas';

export type PublishedMap = {
  buildingAngle?: number;
  aisleReach?: number;
  byArea: Record<AreaId, AreaState>;
};
`;

/** Zone ids with a clip committed under public/clips. */
const PUBLISHED_CLIPS = new Set<string>(PUBLISHED_CLIP_IDS);

/** Whether a zone has a guide at all, from either source. */
function hasAnyClip(id: string): boolean {
  const state = areaState(id);
  // publishedClips is the list of zone ids that have a file committed. Checking
  // a list rather than probing the network keeps the menu honest offline and
  // avoids nineteen requests for files that mostly are not there yet.
  return state.hasVideo === true || Boolean(state.videoUrl) || PUBLISHED_CLIPS.has(id);
}

/** Which zone's clip is currently loaded, so it is not reloaded needlessly. */
let lastClip: string | null = null;

/** Resolves when a guide finishes speaking, or immediately if she cannot. */
function waitForClip(handle: PresenterHandle): Promise<void> {
  const video = handle?.component.video;
  if (!video) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('ended', done);
      resolve();
    };
    video.addEventListener('ended', done);
    setTimeout(done, 60_000);
  });
}

// ---------------------------------------------------------------- author UI

// One build, two views.
//
// The visitor experience is the real product and the author panel is an overlay
// on top of it, rather than two separate modes. Built as two modes they drift:
// something gets fixed in the one you are looking at and not the other, and the
// difference is only found by a visitor. This way the visitor view is simply
// this view with the tools hidden.
// Placing zones by standing in them.
//
// Nineteen zones tapped out one floor circle at a time is an evening's work and
// an error every few minutes. Walking to a zone and pressing Place here is the
// same information gathered the way the space actually reads — and it snaps to
// the circle you are standing on, so the saved point is always somewhere a
// visitor can be sent.
/** The slabs, once the scene has them. Null until then, and for visitors. */
let overlay: ZoneOverlayComponent | null = null;

/** The viewer's latest pose: needed for facing, capture and travel alike. */
let lastPose: any = null;

/** Which zone the author has selected, so the overlay can mark it out. */
let selectedZone: string | null = null;

export function refreshZoneOverlay(): void {
  overlay?.rebuild(placedAreas(), buildingAngle(), selectedZone ?? undefined);
}

function wireAreaAuthoring(mpSdk: any): void {
  const picker = document.querySelector('#area-pick') as HTMLSelectElement;
  const unplace = document.querySelector('#area-clear') as HTMLButtonElement;
  const angle = document.querySelector('#building-angle') as HTMLInputElement;
  const angleOut = document.querySelector('#building-angle-value') as HTMLOutputElement;
  const status = document.querySelector('#area-status') as HTMLElement;
  const assign = document.querySelector('#area-video') as HTMLButtonElement;
  if (!picker) return;

  for (const area of AREAS) {
    const option = document.createElement('option');
    option.value = area.id;
    option.textContent = area.name;
    picker.appendChild(option);
  }

  const chosen = () => AREAS.find((a) => a.id === picker.value) ?? AREAS[0];

  // A tick in the dropdown against every zone already mapped, so the list is
  // its own record of what is left rather than something to hold in your head.
  const markPlaced = () => {
    for (const option of Array.from(picker.options)) {
      const area = AREAS.find((a) => a.id === option.value);
      if (!area) continue;
      const state = areaState(area.id);
      const marks = `${isPlaced(state) ? '\u2713' : '\u00b7'}${state.hasVideo ? '\u25b6' : ''}`;
      option.textContent = `${marks} ${area.name}`;
    }
  };

  const show = () => {
    selectedZone = chosen().id;
    const state = areaState(chosen().id);
    const done = placedAreas().length;
    const marks = [
      isPlaced(state) ? 'zone' : null,
      state.viewSweep ? 'view' : null,
      state.guideAt ? 'guide' : null,
      state.hasVideo ? 'clip' : null,
    ].filter(Boolean);
    status.textContent = marks.length
      ? `${chosen().name}: ${marks.join(', ')}. ${done} of ${AREAS.length} zones drawn.`
      : `${chosen().name}: nothing set yet. ${done} of ${AREAS.length} zones drawn.`;
    angle.value = String(buildingAngle());
    angleOut.textContent = `${buildingAngle().toFixed(1)}\u00b0`;
    markPlaced();
  };

  picker.addEventListener('change', () => {
    selectedZone = picker.value;
    show();
    refreshZoneOverlay();
  });


  unplace.addEventListener('click', () => {
    saveArea(chosen().id, { cornerA: undefined, cornerB: undefined });
    diag.info(`${chosen().name}: unplaced.`);
    show();
    refreshZoneOverlay();
  });

  // One angle for the whole building rather than a rotation per zone. The plan
  // is axis-aligned to the walls; Matterport's axes are aligned to however the
  // scan happened to start. Nineteen per-zone rotations would be nineteen
  // chances to get the same number slightly wrong.
  const reach = document.querySelector('#aisle-reach') as HTMLInputElement;
  const reachOut = document.querySelector('#aisle-reach-value') as HTMLOutputElement;
  reach.value = String(aisleReach());
  reachOut.textContent = `${aisleReach().toFixed(1)} m`;
  reach.addEventListener('input', () => {
    const metres = Number(reach.value);
    reachOut.textContent = `${metres.toFixed(1)} m`;
    setAisleReach(metres);
  });

  angle.addEventListener('input', () => {
    const degrees = Number(angle.value);
    angleOut.textContent = `${degrees.toFixed(1)}\u00b0`;
    setBuildingAngle(degrees);
    refreshZoneOverlay();
  });

  // Authored viewpoints.
  //
  // Stand where a visitor should land, look where they should look, press the
  // button. Everything the automatic version was guessing at - which side of a
  // display reads best, which circle has a pillar in the way - is decided by
  // someone who can see it.
  document.querySelector('#area-view')?.addEventListener('click', () => {
    const pose = lastPose;
    if (!pose?.sweep) {
      diag.warn('No sweep underfoot to capture.');
      return;
    }
    saveArea(chosen().id, {
      viewSweep: pose.sweep,
      viewYaw: pose.rotation?.y ?? 0,
      viewPitch: pose.rotation?.x ?? 0,
    });
    diag.info(`${chosen().name}: view captured.`);
    show();
  });

  document.querySelector('#area-guide')?.addEventListener('click', () => {
    const from = handles[0]?.component.viewerPosition();
    if (!from) {
      diag.warn('No position yet.');
      return;
    }
    // Her feet, not the camera: you are standing where she should stand, and
    // the camera is at your eye level.
    const floorOffset = loadGlobal().floorOffset ?? DEFAULT_FLOOR_OFFSET;
    saveArea(chosen().id, { guideAt: { x: from.x, y: from.y - floorOffset, z: from.z } });
    diag.info(`${chosen().name}: guide spot set.`);
    show();
  });

  // Dropping a model into the space.
  //
  // Uploaded rather than fetched from a URL: hosting a file somewhere public
  // just to look at it is a chore, and one that has to be repeated every time
  // the model changes.
  //
  // .glb only, and that is not a limitation of the upload. An OBJ is three
  // files that find each other by relative path - the .obj names the .mtl, the
  // .mtl names the .png - and a blob URL has no folder for those names to
  // resolve against. A .glb carries its texture inside it, so there is nothing
  // to resolve. OBJ still works when properly hosted; it just cannot be dropped
  // in from a phone.
  let modelObject: any = null;
  let modelLoader: any = null;
  let modelUrl: string | null = null;

  const modelStatus = document.querySelector('#model-status') as HTMLElement;
  const modelFile = document.querySelector('#model-file') as HTMLInputElement;

  const useModel = (blob: Blob, name: string) => {
    if (modelUrl) URL.revokeObjectURL(modelUrl);
    modelUrl = URL.createObjectURL(blob);
    modelStatus.textContent = `${name} ready. Stand where you want it, then Place.`;
  };

  document.querySelector('#model-load')?.addEventListener('click', () => modelFile.click());

  modelFile?.addEventListener('change', async () => {
    const file = modelFile.files?.[0];
    if (!file) return;

    useModel(file, file.name);
    diag.info(`${file.name}: ${(file.size / 1024 / 1024).toFixed(1)} MB`);

    try {
      // Kept on the device like the video, so it survives a reload rather than
      // needing to be picked again every time the page refreshes.
      await saveVideo('model:test', file);
    } catch (error) {
      diag.warn(`Could not keep the model on this device: ${describeError(error)}`);
    }
    modelFile.value = '';
  });

  void (async () => {
    const saved = await loadVideo('model:test');
    if (saved) {
      useModel(saved.blob, saved.name ?? 'saved model');
      diag.info(`Model restored (${saved.sizeMb.toFixed(1)} MB).`);
    }
  })();

  document.querySelector('#model-place')?.addEventListener('click', async () => {
    const from = handles[0]?.component.viewerPosition();
    if (!modelUrl || !from) {
      diag.warn('Load a model first, then stand where you want it.');
      return;
    }

    try {
      modelObject?.stop?.();
      const [object] = await mpSdk.Scene.createObjects(1);
      const node = object.addNode();

      // Position through the component's own input rather than by reaching into
      // obj3D. The loader builds its subtree when it finishes loading, well
      // after the node was positioned, and it positions that subtree from
      // localPosition - so anything set directly on the node is overwritten by
      // the default of {0,0,0} the moment the model arrives. That alone puts
      // the model at the world origin, which in this space is off in a corner.
      const floorOffset = loadGlobal().floorOffset ?? DEFAULT_FLOOR_OFFSET;
      const loader = (modelLoader = node.addComponent('mp.gltfLoader', {
        url: modelUrl,
        localPosition: { x: from.x, y: from.y - floorOffset, z: from.z },
        localScale: { x: 1, y: 1, z: 1 },
        visible: true,
      }));

      node.addComponent('mp.lights');
      object.start();
      modelObject = object;

      // loadingState is the component's own verdict: Idle, Loading, Loaded or
      // Error. Loading fails asynchronously, long after addComponent has
      // returned happily, so this is the only place the truth shows up.
      let ticks = 0;
      const watch = window.setInterval(() => {
        const state = loader?.outputs?.loadingState ?? 'unknown';
        ticks += 1;
        if (state === 'Loaded' || state === 'Error' || ticks > 20) {
          window.clearInterval(watch);
          diag.info(`Model ${state} after ${(ticks * 0.5).toFixed(1)}s.`);
          modelStatus.textContent =
            state === 'Loaded'
              ? 'Loaded. Walk round it to check scale and facing.'
              : `Loader says: ${state}. The red wireframe marks where it should be.`;
        }
      }, 500);

    } catch (error) {
      diag.error(`Could not place the model: ${describeError(error)}`);
    }
  });

  document.querySelector('#model-clear')?.addEventListener('click', () => {
    // Hide first, then stop. stop() ends the components, but the subtree the
    // loader built belongs to the loader and does not reliably go with them -
    // and a model that is still on screen after Remove is worse than one that
    // never appeared, because now you doubt the button.
    try {
      if (modelLoader?.inputs) modelLoader.inputs.visible = false;
    } catch {
      /* the component may already be gone */
    }
    modelObject?.stop?.();
    modelObject = null;
    modelLoader = null;
    modelStatus.textContent = modelUrl ? 'Removed. Place again to re-add.' : 'No model loaded.';
  });

  document.querySelector('#area-check')?.addEventListener('click', () => {
    const findings = checkZones(allSweeps());
    for (const finding of findings) diag[finding.level === 'ok' ? 'info' : finding.level](finding.text);
    const faults = findings.filter((f) => f.level === 'error').length;
    status.textContent = faults
      ? `${faults} problem${faults === 1 ? '' : 's'} \u2014 see Diagnostics.`
      : 'Zones check out. See Diagnostics for detail.';
  });

  // Publishing.
  //
  // Everything authored so far lives in this browser, which is right while
  // drawing and useless afterwards: a visitor has none of it. These two buttons
  // are the whole bridge - the map becomes a file in the repository, and a clip
  // becomes a file served with the site.
  const keyField = document.querySelector('#publish-key') as HTMLInputElement;
  const publishStatus = document.querySelector('#publish-status') as HTMLElement;
  keyField.value = publishKey();
  keyField.addEventListener('change', () => setPublishKey(keyField.value.trim()));

  document.querySelector('#publish-map')?.addEventListener('click', async () => {
    setPublishKey(keyField.value.trim());
    publishStatus.textContent = 'Publishing the map\u2026';

    // Written as a TypeScript module rather than JSON so it is compiled into the
    // bundle: a visitor then has the zones before the first frame, with no fetch
    // to wait for and nothing to fail.
    const map = JSON.parse(exportZones()) as {
      buildingAngle?: number;
      aisleReach?: number;
      zones: ({ id: string } & Record<string, unknown>)[];
    };
    const byArea: Record<string, unknown> = {};
    for (const zone of map.zones) {
      const { id, name, ...rest } = zone as any;
      void name;
      byArea[id] = rest;
    }

    const source = `${PUBLISHED_HEADER}
export const PUBLISHED: PublishedMap = ${JSON.stringify(
      { buildingAngle: map.buildingAngle, aisleReach: map.aisleReach, byArea },
      null,
      2,
    )};

export const PUBLISHED_CLIP_IDS: string[] = ${JSON.stringify(PUBLISHED_CLIP_IDS)};
`;

    const result = await publish(
      'src/areas.published.ts',
      new Blob([source], { type: 'application/octet-stream' }),
      `Publish zone map (${map.zones.length} zones)`,
    );
    publishStatus.textContent = result.ok
      ? `Map published. Vercel is rebuilding; give it a minute.`
      : `Could not publish: ${result.error}`;
  });

  document.querySelector('#publish-clip')?.addEventListener('click', async () => {
    setPublishKey(keyField.value.trim());
    const area = chosen();
    const saved = await loadVideo(`area:${area.id}`);
    if (!saved) {
      publishStatus.textContent = `No clip loaded for ${area.name} on this device.`;
      return;
    }

    // Raw bytes, not base64: a serverless request body is capped around 4.5MB,
    // and encoding would spend a third of that on nothing.
    const mb = saved.blob.size / 1024 / 1024;
    if (mb > 4.2) {
      publishStatus.textContent = `${mb.toFixed(1)} MB is too large to publish this way. Keep clips under about 4 MB.`;
      return;
    }

    publishStatus.textContent = `Publishing ${mb.toFixed(1)} MB\u2026`;
    const result = await publish(
      `public/clips/${area.id}.mp4`,
      saved.blob,
      `Publish clip for ${area.name}`,
    );
    publishStatus.textContent = result.ok
      ? `${area.name} clip published. Add it to PUBLISHED_CLIP_IDS by publishing the map again.`
      : `Could not publish: ${result.error}`;
  });

  document.querySelector('#area-import')?.addEventListener('click', () => {
    const box = document.querySelector('#area-import-text') as HTMLTextAreaElement;
    try {
      const count = importMap(box.value);
      box.value = '';
      diag.info(`${count} zones loaded.`);
      show();
      refreshZoneOverlay();
    } catch (error) {
      diag.error(`That is not a zone map: ${describeError(error)}`);
    }
  });

  document.querySelector('#area-export')?.addEventListener('click', () => {
    const json = exportZones();
    navigator.clipboard
      ?.writeText(json)
      .then(() => diag.info('Zone map copied.'))
      .catch(() => diag.warn('Clipboard blocked. Map: ' + json));
  });

  assign.addEventListener('click', () => {
    const input = document.querySelector('#video-file') as HTMLInputElement;
    assigningTo = chosen().id;
    input.click();
  });

  // Drawing zones on the floor plan.
  //
  // Walking to every corner of nineteen zones is an evening's work; the plan
  // view already shows the whole building at once, and a tap there returns a
  // real world position. Corners here are deliberately NOT snapped to floor
  // circles: a zone edge usually runs along a wall, where nobody ever stood.
  const draw = document.querySelector('#area-draw') as HTMLButtonElement;
  const layer = document.querySelector('#draw-layer') as HTMLElement;
  const rect = document.querySelector('#draw-rect') as HTMLElement;

  let drawing = false;
  let toWorld: ScreenToWorld | null = null;
  let from: { x: number; y: number } | null = null;
  let floorY = 0;
  const setDrawing = async (on: boolean) => {
    drawing = on;
    from = null;
    rect.hidden = true;
    layer.hidden = !on;
    draw.setAttribute('aria-pressed', String(on));
    draw.textContent = on ? 'Done drawing' : 'Draw on floor plan';

    try {
      const mode = on ? mpSdk?.Mode?.Mode?.FLOORPLAN : mpSdk?.Mode?.Mode?.INSIDE;
      if (mode) await mpSdk.Mode.moveTo(mode);
    } catch {
      diag.warn('Could not switch to the floor plan.');
    }

    if (!on) {
      show();
      refreshZoneOverlay();
      return;
    }

    status.textContent = `Drag across ${chosen().name}.`;
  };

  /**
   * Solves the screen-to-floor mapping for the view as it is right now.
   *
   * Done at the start of every drag rather than once on entering the mode.
   * Solved once, the mapping goes stale the moment the plan is panned or
   * zoomed, and a box then lands somewhere other than where it was drawn -
   * with nothing on screen to say why. Twelve points and a 3x3 solve is a
   * fraction of a millisecond, which is a cheap price for never being wrong.
   */
  const remap = (): boolean => {
    // Floor height comes from the presenter, not from a sweep: a sweep records
    // where the capture camera stood, which is eye level.
    floorY = handles[0]?.getPosition().y ?? 0;
    toWorld = calibrate(mpSdk, lastPose, allSweeps());
    if (!toWorld) diag.warn('Plan mapping failed.');
    return Boolean(toWorld);
  };

  draw.addEventListener('click', () => void setDrawing(!drawing));

  const paintRect = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    rect.hidden = false;
    rect.style.left = `${Math.min(a.x, b.x)}px`;
    rect.style.top = `${Math.min(a.y, b.y)}px`;
    rect.style.width = `${Math.abs(a.x - b.x)}px`;
    rect.style.height = `${Math.abs(a.y - b.y)}px`;
  };

  layer.addEventListener('pointerdown', (event) => {
    if (!drawing) return;
    if (!remap()) {
      status.textContent = 'Could not map the plan. Tell me and I will use another route.';
      return;
    }
    layer.setPointerCapture(event.pointerId);
    from = { x: event.clientX, y: event.clientY };
    paintRect(from, from);
  });

  // Drawn in screen space and converted once on release. Rebuilding every slab
  // on every move to preview a rectangle is a lot of work for a box the browser
  // can draw itself, and this way the outline keeps up with a finger exactly.
  layer.addEventListener('pointermove', (event) => {
    if (!drawing || !from) return;
    paintRect(from, { x: event.clientX, y: event.clientY });
  });

  layer.addEventListener('pointerup', (event) => {
    if (!drawing || !from) return;
    const to = { x: event.clientX, y: event.clientY };
    const started = from;
    from = null;
    rect.hidden = true;

    // Set by remap() at pointerdown, and the drag cannot start without it.
    const convert = toWorld;
    if (!convert) return;

    const a = convert(started);
    const b = convert(to);
    const span = Math.hypot(a.x - b.x, a.z - b.z);

    // A stray tap would otherwise leave a zone the size of a coin, which then
    // reports nobody as ever having been inside it.
    if (span < 0.4) {
      status.textContent = `Too small \u2014 drag right across ${chosen().name}.`;
      return;
    }

    saveArea(chosen().id, {
      cornerA: { x: a.x, y: floorY, z: a.z },
      cornerB: { x: b.x, y: floorY, z: b.z },
    });
    diag.info(`${chosen().name}: ${span.toFixed(1)}m across.`);
    refreshZoneOverlay();

    // Advance only while zones are still unplaced. Once the map is complete
    // the picker stays where it is, because from then on every drag is a
    // deliberate redraw of the zone you chose \u2014 moving on would be the tool
    // second-guessing you.
    const redrawn = chosen().name;
    const remaining = AREAS.find((area) => !isPlaced(areaState(area.id)));
    if (remaining) picker.value = remaining.id;
    selectedZone = picker.value;
    markPlaced();
    refreshZoneOverlay();
    status.textContent = remaining
      ? `Saved. Now drag across ${chosen().name}.`
      : `${redrawn} redrawn. Pick another zone to redraw it.`;
  });

  show();
}

/** Set while a file picker is open on behalf of a zone rather than the guide. */
let assigningTo: string | null = null;

function wireRoleToggle(): void {
  const button = document.querySelector('#role-toggle') as HTMLButtonElement;
  if (!button) return;

  button.hidden = false;
  let authoring = true;

  button.addEventListener('click', () => {
    authoring = !authoring;
    devPanel.hidden = !authoring;
    document.querySelector('#diag-panel')?.toggleAttribute('hidden', !authoring);
    button.textContent = authoring ? 'Viewing as author' : 'Viewing as visitor';
    button.setAttribute('aria-pressed', String(!authoring));
  });
}

async function enableDevTools(mpSdk: any, director: ReturnType<typeof createDirector>) {
  devPanel.hidden = false;

  // Only authors get the slabs. They are a drawing aid, not part of the tour.
  overlay = await spawnZoneOverlay(mpSdk);
  refreshZoneOverlay();
  wireRoleToggle();
  wireAreaAuthoring(mpSdk);

  const placement = createPlacementMode(
    mpSdk,
    current,
    () => handles,
    () => onMoved(),
  );

  const onMoved = () => {
    devReadout.textContent = JSON.stringify(placement.exportPlacements(), null, 2);
    const handle = current();
    if (handle) saveFor(handle.id, { position: handle.getPosition() });
  };

  // A tap on a real floor next to a real circle measures the capture camera's
  // height above the floor exactly, which beats any constant I could pick.
  placement.onFloorOffsetLearned = (offset) => {
    saveGlobal({ floorOffset: offset });
    const slider = document.querySelector('#floor-offset') as HTMLInputElement;
    const value = document.querySelector('#floor-offset-value') as HTMLOutputElement;
    slider.value = offset.toFixed(2);
    value.textContent = `${offset.toFixed(2)} m`;
    diag.info(`Floor offset measured from your tap: ${offset.toFixed(2)} m.`);
  };

  const refresh = buildPresenterPicker(director, onMoved);

  wirePanelCollapse();
  wirePlacementButtons(placement, onMoved);
  wirePresenterControls(refresh);
  wireFramingControls();
  wireShadowControls();
  wireSpaceControls();
  wireVideoPicker(director, onMoved);

  refresh();
  onMoved();

  (window as any).mp = { mpSdk, handles, director, placement };
  diag.info(`Dev tools on. ${handles.length} presenter slots.`);
}

/**
 * One button per presenter slot.
 *
 * Built from the config rather than hard-coded, so adding a fifth guide is a
 * config entry and nothing else. Slots start hidden and appear when placed,
 * which is what makes an empty slot feel like "not created yet" rather than
 * like a bug.
 */
function buildPresenterPicker(
  director: ReturnType<typeof createDirector>,
  onMoved: () => void,
): () => void {
  const picker = document.querySelector('#presenter-picker') as HTMLElement;
  const visibleButton = document.querySelector('#toggle-visible') as HTMLButtonElement;

  const buttons = handles.map((handle, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(index + 1);
    button.title = displayName(handle);
    button.addEventListener('click', () => {
      selected = index;
      saveGlobal({ selected: handle.id });
      refresh();
      onMoved();
      diag.info(`Editing ${handle.id}.`);
    });
    picker.appendChild(button);
    return button;
  });

  const nameField = document.querySelector('#presenter-name') as HTMLInputElement;
  nameField.addEventListener('input', () => {
    const handle = current();
    if (!handle) return;
    saveFor(handle.id, { name: nameField.value });
    buttons.forEach((b, i) => {
      const h = handles[i];
      if (h) b.title = displayName(h);
    });
  });

  visibleButton.addEventListener('click', () => {
    const handle = current();
    if (!handle) return;
    const next = !handle.component.inputs.visible;
    handle.component.setVisible(next);
    saveFor(handle.id, { visible: next });
    refresh();
  });

  function refresh() {
    buttons.forEach((button, index) => {
      const isSelected = index === selected;
      const placed = handles[index]?.component.inputs.visible;
      button.setAttribute('aria-pressed', String(isSelected));
      button.textContent = placed ? String(index + 1) : `${index + 1}\u00b7`;
    });

    const handle = current();
    const visible = handle?.component.inputs.visible ?? false;
    visibleButton.textContent = visible ? 'Visible' : 'Hidden';
    visibleButton.setAttribute('aria-pressed', String(visible));

    syncControlsToSelection();
  }

  void director;
  return refresh;
}

/** Pushes the selected presenter's saved values back into the sliders. */
function syncControlsToSelection() {
  const handle = current();
  if (!handle) return;
  const saved = loadFor(handle.id);
  const global = loadGlobal();

  setSlider('#height-slider', '#height-value', saved.personHeight ?? 2, (v) => `${v.toFixed(2)} m`);
  setSlider('#trim-start', '#trim-start-value', saved.startAt ?? 0.7, (v) => `${v.toFixed(2)} s`);
  setSlider('#shadow-size', '#shadow-size-value', saved.shadowDiameter ?? 1.65, (v) =>
    v > 0 ? `${v.toFixed(2)} m` : 'off',
  );
  setSlider('#shadow-depth', '#shadow-depth-value', saved.shadowOpacity ?? 0.55, (v) =>
    `${Math.round(v * 100)}%`,
  );
  setSlider(
    '#summon-distance',
    '#summon-distance-value',
    saved.summonDistance ?? DEFAULT_SUMMON_DISTANCE,
    (v) => `${v.toFixed(1)} m`,
  );
  setSlider(
    '#floor-offset',
    '#floor-offset-value',
    global.floorOffset ?? DEFAULT_FLOOR_OFFSET,
    (v) => `${v.toFixed(2)} m`,
  );

  setSlider('#frame-width', '#frame-width-value', saved.frameWidth ?? 1, pct);
  setSlider('#crop-bottom', '#crop-bottom-value', saved.cropBottom ?? 0, pct);
  setSlider('#crop-top', '#crop-top-value', saved.cropTop ?? 0, pct);
  setSlider('#ground-offset', '#ground-offset-value', saved.groundOffset ?? 0,
    (v) => `${v.toFixed(2)} m`,
  );
  setSlider('#brightness', '#brightness-value', saved.brightness ?? 1, pct);

  const mode = document.querySelector('#mode-toggle') as HTMLButtonElement;
  const onApproach = saved.mode === 'onApproach';
  mode.textContent = onApproach ? 'Appears on approach' : 'Always visible';
  mode.setAttribute('aria-pressed', String(onApproach));

  setSlider('#trigger-radius', '#trigger-radius-value', saved.triggerRadius ?? 2.5,
    (v) => `${v.toFixed(1)} m`,
  );



  const facing = document.querySelector('#facing') as HTMLButtonElement;
  const full = saved.billboardMode === 'full';
  facing.textContent = full ? 'Facing: always' : 'Facing: upright';
  facing.setAttribute('aria-pressed', String(full));
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function setSlider(
  sliderId: string,
  outputId: string,
  value: number,
  format: (v: number) => string,
) {
  const slider = document.querySelector(sliderId) as HTMLInputElement;
  const output = document.querySelector(outputId) as HTMLOutputElement;
  if (!slider || !output) return;
  slider.value = String(value);
  output.textContent = format(value);
}

// On a tablet the panel covers a third of the screen, which makes judging the
// presenter against the room impossible while any control is visible.
function wirePanelCollapse() {
  const button = document.querySelector('#panel-toggle') as HTMLButtonElement;
  const body = document.querySelector('#dev-body') as HTMLElement;
  if (!button || !body) return;

  let open = true;
  button.addEventListener('click', () => {
    open = !open;
    body.hidden = !open;
    button.textContent = open ? 'Hide' : 'Show';
    button.setAttribute('aria-expanded', String(open));
    devPanel.classList.toggle('collapsed', !open);
  });
}

function wirePlacementButtons(
  placement: ReturnType<typeof createPlacementMode>,
  onMoved: () => void,
) {
  const mode = document.querySelector('#dev-toggle') as HTMLButtonElement;
  mode.addEventListener('click', () => {
    placement.setActive(!placement.active);
    mode.setAttribute('aria-pressed', String(placement.active));
  });

  const snap = document.querySelector('#snap-toggle') as HTMLButtonElement;
  if (loadGlobal().snapToCircles === false) placement.setSnap(false);
  const showSnap = () => {
    snap.textContent = placement.snapping ? 'Snap: circles' : 'Snap: off';
    snap.setAttribute('aria-pressed', String(placement.snapping));
  };
  showSnap();

  snap.addEventListener('click', () => {
    placement.setSnap(!placement.snapping);
    showSnap();
    saveGlobal({ snapToCircles: placement.snapping });
  });

  // Raise and Lower move her relative to the floor rather than in world space.
  // Nudging raw y worked until the next summon recomputed the floor and threw
  // the adjustment away; a stored offset survives every future move.
  const nudgeGround = (delta: number) => {
    const handle = current();
    if (!handle) return;
    const next = Math.round((handle.component.inputs.groundOffset + delta) * 1000) / 1000;
    handle.component.setGroundOffset(next);
    saveFor(handle.id, { groundOffset: next });
    setSlider('#ground-offset', '#ground-offset-value', next, (v) => `${v.toFixed(2)} m`);
    diag.info(`Ground offset: ${next.toFixed(2)} m`);
  };

  document.querySelector('#nudge-up')!.addEventListener('click', () => nudgeGround(0.02));
  document.querySelector('#nudge-down')!.addEventListener('click', () => nudgeGround(-0.02));

  wireDirectionalNudges(onMoved);
}

// "Left" means left as seen from where you are standing, not along a fixed
// world axis. World X and Z are unusable in practice: which way she moves
// depends on which direction you happen to be facing, so the buttons feel
// random and you end up guessing.
function wireDirectionalNudges(onMoved: () => void) {
  const STEP = 0.15; // metres per tap: visible, but not so coarse it overshoots

  const move = (right: number, forward: number) => {
    const handle = current();
    if (!handle) return;

    const dir = handle.component.viewerDirection();
    if (!dir) {
      diag.warn('Cannot tell where you are standing, so directional nudges are off.');
      return;
    }

    // Screen-right is the floor-plane perpendicular of the view direction.
    const rx = dir.z;
    const rz = -dir.x;

    const p = handle.getPosition();
    handle.setPosition({
      x: p.x + rx * right * STEP + dir.x * forward * STEP,
      y: p.y,
      z: p.z + rz * right * STEP + dir.z * forward * STEP,
    });
    onMoved();
  };

  document.querySelector('#nudge-left')!.addEventListener('click', () => move(-1, 0));
  document.querySelector('#nudge-right')!.addEventListener('click', () => move(1, 0));
  document.querySelector('#nudge-near')!.addEventListener('click', () => move(0, -1));
  document.querySelector('#nudge-far')!.addEventListener('click', () => move(0, 1));
}

function wirePresenterControls(refresh: () => void) {
  const facing = document.querySelector('#facing') as HTMLButtonElement;
  facing.addEventListener('click', () => {
    const handle = current();
    if (!handle) return;
    const full = handle.component.inputs.billboardMode !== 'full';
    handle.component.setBillboardMode(full ? 'full' : 'yaw');
    saveFor(handle.id, { billboardMode: full ? 'full' : 'yaw' });
    refresh();
    diag.info(handle.component.facingReport());
  });

  onSlider('#height-slider', '#height-value', (v) => `${v.toFixed(2)} m`, (v) => {
    const handle = current();
    if (!handle) return;
    handle.component.setHeightMeters(v);
    saveFor(handle.id, { personHeight: v });
  });

  onSlider('#trim-start', '#trim-start-value', (v) => `${v.toFixed(2)} s`, (v) => {
    const handle = current();
    if (!handle) return;
    handle.component.setStartAt(v);
    saveFor(handle.id, { startAt: v });
  });

  onSlider('#brightness', '#brightness-value', pct, (v) => {
    const handle = current();
    if (!handle) return;
    handle.component.setBrightness(v);
    saveFor(handle.id, { brightness: v });
  });

  const mode = document.querySelector('#mode-toggle') as HTMLButtonElement;
  mode.addEventListener('click', () => {
    const handle = current();
    if (!handle) return;
    const next = handle.component.inputs.mode === 'always' ? 'onApproach' : 'always';
    handle.component.setMode(next);
    saveFor(handle.id, { mode: next });
    refresh();
    diag.info(
      next === 'onApproach'
        ? `${handle.id}: hidden behind a marker until someone comes close.`
        : `${handle.id}: always visible.`,
    );
  });
}

// Marker style cycles rather than offering three buttons: the panel is already
// dense on a tablet, and the three states are mutually exclusive.

function wireFramingControls() {
  const apply = () => {
    const handle = current();
    if (!handle) return;
    const kept = Number((document.querySelector('#frame-width') as HTMLInputElement).value);
    const top = Number((document.querySelector('#crop-top') as HTMLInputElement).value);
    const bottom = Number((document.querySelector('#crop-bottom') as HTMLInputElement).value);
    saveFor(handle.id, { frameWidth: kept, cropTop: top, cropBottom: bottom });
    applyFraming(handle, loadFor(handle.id));
  };

  onSlider('#frame-width', '#frame-width-value', pct, apply);
  onSlider('#crop-top', '#crop-top-value', pct, apply);
  onSlider('#crop-bottom', '#crop-bottom-value', pct, apply);

  onSlider('#ground-offset', '#ground-offset-value', (v) => `${v.toFixed(2)} m`, (v) => {
    const handle = current();
    if (!handle) return;
    handle.component.setGroundOffset(v);
    saveFor(handle.id, { groundOffset: v });
  });
}

function wireShadowControls() {
  const apply = () => {
    const handle = current();
    if (!handle) return;
    const d = Number((document.querySelector('#shadow-size') as HTMLInputElement).value);
    const o = Number((document.querySelector('#shadow-depth') as HTMLInputElement).value);
    handle.component.setShadow(d, o);
    saveFor(handle.id, { shadowDiameter: d, shadowOpacity: o });
  };

  onSlider('#shadow-size', '#shadow-size-value', (v) => (v > 0 ? `${v.toFixed(2)} m` : 'off'), apply);
  onSlider('#shadow-depth', '#shadow-depth-value', (v) => `${Math.round(v * 100)}%`, apply);
}

function wireSpaceControls() {
  onSlider('#summon-distance', '#summon-distance-value', (v) => `${v.toFixed(1)} m`, (v) => {
    const handle = current();
    if (handle) saveFor(handle.id, { summonDistance: v });
  });

  onSlider('#floor-offset', '#floor-offset-value', (v) => `${v.toFixed(2)} m`, (v) => {
    saveGlobal({ floorOffset: v });
  });
}

/** Wires a slider to a formatter and a handler, without firing on setup. */
function onSlider(
  sliderId: string,
  outputId: string,
  format: (v: number) => string,
  handle: (v: number) => void,
) {
  const slider = document.querySelector(sliderId) as HTMLInputElement;
  const output = document.querySelector(outputId) as HTMLOutputElement;
  if (!slider || !output) return;

  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    output.textContent = format(value);
    handle(value);
  });
}

// A local blob URL means full-resolution video with nothing uploaded and no
// redeploy. The bytes are kept in IndexedDB, keyed per presenter, so each guide
// keeps her own clip across reloads. Production footage still gets a real
// hosted path in presenters.config.ts.
function wireVideoPicker(director: ReturnType<typeof createDirector>, onMoved: () => void) {
  const input = document.querySelector('#video-file') as HTMLInputElement;
  const button = document.querySelector('#load-video') as HTMLButtonElement;
  if (!input || !button) return;

  button.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    const handle = current();
    if (!file || !handle) return;

    const target = assigningTo;
    assigningTo = null;

    if (target) {
      // Stored against the zone, not the renderer: the clip belongs to the
      // place it describes, and she is only the surface that plays it.
      try {
        await saveVideo(`area:${target}`, file);
        saveArea(target, { hasVideo: true });
        diag.info(`Clip stored for ${target}.`);
      } catch (error) {
        diag.warn(`Could not store the clip: ${describeError(error)}`);
      }
      input.value = '';
      return;
    }

    diag.info(`${handle.id}: loading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    resetFramingFor(handle);
    handle.component.useVideo(URL.createObjectURL(file), file.name);
    handle.component.setVisible(true);
    saveFor(handle.id, { visible: true });

    // Choosing a file is a user gesture, so audio is permitted from here.
    director.unmute();
    void handle.component.play(false);

    try {
      await saveVideo(handle.id, file);
      diag.info('Saved to this device — it will come back on reload.');
    } catch (error) {
      diag.warn(`Could not save to this device: ${describeError(error)}`);
    }
  });

  document.querySelector('#summon')!.addEventListener('click', () => {
    summon(director, (window as any).mp?.mpSdk);
    onMoved();
  });

  document.querySelector('#replay')!.addEventListener('click', () => {
    const handle = current();
    if (!handle) return;
    director.unmute();
    director.replay(handle.id);
    diag.info(`${handle.id}: replaying from the start.`);
  });

  document.querySelector('#clear-video')!.addEventListener('click', () => {
    const handle = current();
    if (!handle) return;
    void clearVideo(handle.id);
    diag.info(`${handle.id}: saved video cleared. Reload to return to the stand-in.`);
  });

  document
    .querySelector('#dev-copy')!
    .addEventListener('click', () => void (document.querySelector('#dev-readout') && navigator.clipboard
      ?.writeText(devReadout.textContent ?? '')
      .then(() => diag.info('Placements copied to clipboard.'))
      .catch(() => diag.warn('Clipboard blocked.'))));

  document.querySelector('#reset-settings')!.addEventListener('click', () => clearSettings());
}

main().catch((error) => {
  startPanel.hidden = false;
  startPanel.innerHTML =
    '<p class="notice"><strong>Something went wrong.</strong><br><br>' +
    'The details are in the Diagnostics panel. Tap Copy there and send it over ' +
    'so the actual cause can be read rather than guessed at.</p>';
  diag.error(`Startup halted: ${describeError(error)}`);
});
