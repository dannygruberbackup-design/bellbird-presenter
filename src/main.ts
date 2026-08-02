// Must come first: it pre-sets window.THREE so the web component does not
// install a null-prototype namespace that breaks every addComponent call.
import './three-global';
import '@matterport/webcomponent';
import './ui.css';

import { spawnPresenters, type PresenterHandle } from './scene';
import { createDirector } from './presenter-director';
import { createCaptionController } from './captions';
import { createPlacementMode } from './placement';
import { PRESENTERS, DIRECTOR_OPTIONS } from './presenters.config';
import { SDK_KEY, MODEL_SID, IS_DEV, SHOW_DIAG, WANT_LIGHTS } from './config';
import { initDiagnostics, diag, describeError } from './diagnostics';
import { connectSdk } from './connect';
import { saveVideo, loadVideo, clearVideo } from './video-store';
import { subscribeSweeps, nearestSweep } from './sweeps';
import { stationsFrom, goToStation, isInside, lookAt, type Station } from './stations';
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

  if (IS_DEV) enableDevTools(mpSdk, director);
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
    if (saved.beaconStyle) handle.component.setBeaconStyle(saved.beaconStyle);
    if (saved.beaconSize !== undefined || saved.beaconHeight !== undefined) {
      handle.component.setBeaconShape(saved.beaconSize ?? 0.34, saved.beaconHeight ?? 1.5);
    }
    if (saved.beaconSpeed !== undefined) handle.component.setBeaconSpeed(saved.beaconSpeed);
    if (saved.beaconTurn !== undefined || saved.beaconTilt !== undefined || saved.beaconRoll !== undefined) {
      handle.component.setBeaconAngles(
        saved.beaconTurn ?? 0,
        saved.beaconTilt ?? 0,
        saved.beaconRoll ?? 0,
      );
    }
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

// The menu, the walkthrough and the beacons are three doors into the same list
// of stations. Built fresh each time it opens, because a guide can be placed or
// hidden at any moment and a stale menu that sends someone nowhere is worse
// than no menu.
function wireStations(mpSdk: any, director: ReturnType<typeof createDirector>) {
  const panel = document.querySelector('#stations') as HTMLElement;
  const toggle = document.querySelector('#stations-toggle') as HTMLButtonElement;
  const list = document.querySelector('#station-list') as HTMLElement;
  const walkButton = document.querySelector('#walkthrough') as HTMLButtonElement;
  if (!panel || !toggle || !list) return;

  let walking = false;
  let rows: { station: Station; li: HTMLElement }[] = [];

  const close = () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  // Travel, then speak. Two separate acts on the menu because they are two
  // separate wants: "show me that area" and "tell me about it" are not the same
  // request, and forcing them together means you cannot look around in peace.
  const travel = async (station: Station) => {
    close();
    await goToStation(mpSdk, station, () => {});
  };

  const call = async (station: Station) => {
    close();
    await goToStation(mpSdk, station, () => {
      selected = handles.findIndex((h) => h.id === station.handle.id);
      summon(director, mpSdk);
    });
  };

  const rebuild = () => {
    list.textContent = '';
    rows = stationsFrom(handles, displayName).map((station) => {
      const li = document.createElement('li');

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      go.textContent = station.label;
      go.addEventListener('click', () => {
        walking = false;
        void travel(station);
      });

      const guide = document.createElement('button');
      guide.type = 'button';
      guide.className = 'call';
      guide.textContent = '\u25b6';
      guide.title = `Bring the guide to ${station.label}`;
      guide.setAttribute('aria-label', guide.title);
      guide.addEventListener('click', () => {
        walking = false;
        void call(station);
      });

      li.append(go, guide);
      list.appendChild(li);
      return { station, li };
    });
    paint();
  };

  /** Lights the area the visitor is currently standing in. */
  const paint = () => {
    for (const row of rows) row.li.classList.toggle('here', isInside(row.station));
  };

  // Painted on a timer rather than on every frame: the menu only has to keep up
  // with walking, and a quarter of a second is imperceptible for that.
  window.setInterval(() => {
    if (!panel.hidden) paint();
  }, 250);

  toggle.addEventListener('click', () => {
    const opening = panel.hidden;
    if (opening) rebuild();
    panel.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
  });

  // The walkthrough is the same list played in order: travel, speak, wait for
  // the clip to end, move on. Waiting on 'ended' rather than a timer means a
  // long clip is never cut off and a short one never leaves a silent gap.
  walkButton?.addEventListener('click', async () => {
    const stations = stationsFrom(handles, displayName);
    if (stations.length === 0) return;

    walking = true;
    close();
    diag.info(`Walkthrough: ${stations.length} stops.`);

    for (const station of stations) {
      if (!walking) break;
      await call(station);
      await waitForClip(station.handle);
    }

    walking = false;
    diag.info('Walkthrough finished.');
  });
}

/** Resolves when a guide finishes speaking, or immediately if she cannot. */
function waitForClip(handle: PresenterHandle): Promise<void> {
  const video = handle.component.video;
  if (!video) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('ended', done);
      resolve();
    };
    video.addEventListener('ended', done);
    // A clip that never fires 'ended' must not strand the walkthrough forever.
    setTimeout(done, 60_000);
  });
}

// ---------------------------------------------------------------- author UI

function enableDevTools(mpSdk: any, director: ReturnType<typeof createDirector>) {
  devPanel.hidden = false;

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
  wireMarkerControls(refresh);
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

  setSlider('#beacon-size', '#beacon-size-value', saved.beaconSize ?? 0.34,
    (v) => `${v.toFixed(2)} m`,
  );
  setSlider('#beacon-height', '#beacon-height-value', saved.beaconHeight ?? 1.5,
    (v) => `${v.toFixed(2)} m`,
  );
  const deg = (v: number) => `${Math.round(v)}°`;
  setSlider('#beacon-speed', '#beacon-speed-value', saved.beaconSpeed ?? 8,
    (v) => `${v.toFixed(1)} rpm`,
  );
  setSlider('#beacon-turn', '#beacon-turn-value', saved.beaconTurn ?? 0, deg);
  setSlider('#beacon-tilt', '#beacon-tilt-value', saved.beaconTilt ?? 0, deg);
  setSlider('#beacon-roll', '#beacon-roll-value', saved.beaconRoll ?? 0, deg);
  setSlider('#trigger-radius', '#trigger-radius-value', saved.triggerRadius ?? 2.5,
    (v) => `${v.toFixed(1)} m`,
  );


  const beaconButton = document.querySelector('#beacon-style') as HTMLButtonElement;
  const style = saved.beaconStyle ?? 'spin';
  beaconButton.textContent =
    style === 'spin'
      ? 'Marker: turning ring'
      : style === 'static'
        ? 'Marker: still ring'
        : 'Marker: off';

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
const BEACON_STYLES = ['spin', 'static', 'off'] as const;

function wireMarkerControls(refresh: () => void) {
  const button = document.querySelector('#beacon-style') as HTMLButtonElement;

  button.addEventListener('click', () => {
    const handle = current();
    if (!handle) return;
    const now = handle.component.inputs.beaconStyle;
    const next = BEACON_STYLES[(BEACON_STYLES.indexOf(now) + 1) % BEACON_STYLES.length];
    handle.component.setBeaconStyle(next);
    saveFor(handle.id, { beaconStyle: next });
    refresh();
  });

  const applyShape = () => {
    const handle = current();
    if (!handle) return;
    const size = Number((document.querySelector('#beacon-size') as HTMLInputElement).value);
    const height = Number((document.querySelector('#beacon-height') as HTMLInputElement).value);
    handle.component.setBeaconShape(size, height);
    saveFor(handle.id, { beaconSize: size, beaconHeight: height });
  };

  onSlider('#beacon-size', '#beacon-size-value', (v) => `${v.toFixed(2)} m`, applyShape);
  onSlider('#beacon-height', '#beacon-height-value', (v) => `${v.toFixed(2)} m`, applyShape);

  const applyAngles = () => {
    const handle = current();
    if (!handle) return;
    const n = (id: string) => Number((document.querySelector(id) as HTMLInputElement).value);
    const turn = n('#beacon-turn');
    const tilt = n('#beacon-tilt');
    const roll = n('#beacon-roll');
    handle.component.setBeaconAngles(turn, tilt, roll);
    saveFor(handle.id, { beaconTurn: turn, beaconTilt: tilt, beaconRoll: roll });
  };

  onSlider('#beacon-speed', '#beacon-speed-value', (v) => `${v.toFixed(1)} rpm`, (v) => {
    const handle = current();
    if (!handle) return;
    handle.component.setBeaconSpeed(v);
    saveFor(handle.id, { beaconSpeed: v });
  });

  const degrees = (v: number) => `${Math.round(v)}°`;
  onSlider('#beacon-turn', '#beacon-turn-value', degrees, applyAngles);
  onSlider('#beacon-tilt', '#beacon-tilt-value', degrees, applyAngles);
  onSlider('#beacon-roll', '#beacon-roll-value', degrees, applyAngles);

  onSlider('#trigger-radius', '#trigger-radius-value', (v) => `${v.toFixed(1)} m`, (v) => {
    const handle = current();
    if (!handle) return;
    handle.component.setTriggerRadius(v);
    saveFor(handle.id, { triggerRadius: v });
  });
}

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

    diag.info(`${handle.id}: loading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
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
