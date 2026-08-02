import type { ChromaPresenterComponent } from './presenter-component';
import type { CaptionController } from './captions';

export type DirectorOptions = {

  triggerRadius: number;

  preloadRadius: number;

  onReturn: 'resume' | 'restart';

  playOnce: boolean;

  hz: number;
};

export const DEFAULT_DIRECTOR: DirectorOptions = {
  triggerRadius: 3.5,
  preloadRadius: 9,

  onReturn: 'restart',
  playOnce: true,
  hz: 8,
};

export type PresenterEntry = {
  id: string;
  component: ChromaPresenterComponent;

  options?: Partial<DirectorOptions>;
};

export function createDirector(
  entries: PresenterEntry[],
  captions: CaptionController,
  baseOptions: Partial<DirectorOptions> = {},
) {
  const options: DirectorOptions = { ...DEFAULT_DIRECTOR, ...baseOptions };
  const completed = new Set<string>();

  let speaking: PresenterEntry | null = null;
  let muted = true;
  let running = false;
  let timer = 0;

  let manual: PresenterEntry | null = null;

  for (const entry of entries) {
    entry.component.onClick = () => {

      muted = false;
      if (speaking?.id === entry.id && entry.component.playing) {
        manual = null;
        stopSpeaking();
      } else {
        completed.delete(entry.id);
        manual = entry;
        entry.component.rewind();
        void startSpeaking(entry);
      }
    };

    entry.component.video.addEventListener('ended', () => {
      completed.add(entry.id);
      if (speaking?.id === entry.id) {
        captions.clear();
        speaking = null;
      }
    });
  }

  // A per-presenter radius beats one global number: a guide beside a doorway
  // needs a tighter trigger than one in the middle of an open floor, or she
  // starts talking at everyone merely passing through.
  function optionsFor(entry: PresenterEntry): DirectorOptions {
    const own = entry.component.inputs.triggerRadius;
    return {
      ...options,
      ...entry.options,
      ...(typeof own === 'number' ? { triggerRadius: own } : {}),
    };
  }

  async function startSpeaking(entry: PresenterEntry) {
    if (speaking && speaking.id !== entry.id) stopSpeaking();
    speaking = entry;
    captions.attach(entry.component.video);
    await entry.component.play(muted);
  }

  function stopSpeaking() {
    if (!speaking) return;
    const previous = speaking;
    speaking = null;
    previous.component.pause();
    captions.detach(previous.component.video);
    if (optionsFor(previous).onReturn === 'restart') previous.component.rewind();
  }

  function evaluate() {
    // Re-arm anyone the visitor has walked away from.
    //
    // Two locks used to clear only on the video's own 'ended' event, and an
    // event that never arrives is a lock that never clears. Pause a clip, hide
    // the guide, or walk off mid-sentence and proximity was dead for the rest
    // of the session. Leaving her radius is the honest signal that the visit
    // is over, so both are released on exit instead.
    //
    // The 1.35 is hysteresis: clearing at exactly the trigger radius would
    // re-arm and re-fire on every small step across the boundary.
    for (const entry of entries) {
      const away = entry.component.distanceToViewer();
      if (!Number.isFinite(away)) continue;
      if (away <= optionsFor(entry).triggerRadius * 1.35) continue;

      completed.delete(entry.id);
      if (manual?.id === entry.id) {
        manual = null;
        if (speaking?.id === entry.id) stopSpeaking();
      }
    }

    if (manual) return;

    let nearest: PresenterEntry | null = null;
    let nearestDistance = Infinity;

    for (const entry of entries) {
      const config = optionsFor(entry);
      const distance = entry.component.distanceToViewer();
      if (!Number.isFinite(distance)) continue;

      if (distance <= config.preloadRadius) entry.component.preload();

      if (config.playOnce && completed.has(entry.id)) continue;
      if (distance > config.triggerRadius) continue;

      if (distance < nearestDistance) {
        nearest = entry;
        nearestDistance = distance;
      }
    }

    if (!nearest) {
      if (speaking) stopSpeaking();
      return;
    }

    if (speaking?.id === nearest.id) return;
    void startSpeaking(nearest);
  }

  function loop() {
    if (!running) return;
    evaluate();
    timer = window.setTimeout(loop, 1000 / options.hz);
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop();
    },

    stop() {
      running = false;
      window.clearTimeout(timer);
      stopSpeaking();
    },

    unmute() {
      muted = false;
      for (const entry of entries) {
        if (entry.component.video) entry.component.video.muted = false;
      }
    },

    mute() {
      muted = true;
      for (const entry of entries) {
        if (entry.component.video) entry.component.video.muted = true;
      }
    },

    replay(id?: string) {
      const entry = id ? entries.find((e) => e.id === id) : entries[0];
      if (!entry) return;
      completed.delete(entry.id);
      manual = entry;
      speaking = entry;
      if (entry.component.video) captions.attach(entry.component.video);
      entry.component.replay();
    },

    resetProgress() {
      completed.clear();
    },

    get speakingId() {
      return speaking?.id ?? null;
    },
  };
}
