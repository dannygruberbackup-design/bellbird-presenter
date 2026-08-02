export type CaptionController = {
  attach(video: HTMLVideoElement): void;
  detach(video: HTMLVideoElement): void;
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  clear(): void;
};

export function createCaptionController(container: HTMLElement): CaptionController {
  let enabled = readPreference();
  const listeners = new WeakMap<HTMLVideoElement, () => void>();

  function render(text: string) {
    if (!enabled || !text) {
      container.textContent = '';
      container.hidden = true;
      return;
    }
    container.textContent = text;
    container.hidden = false;
  }

  function activeTrackOf(video: HTMLVideoElement): TextTrack | null {
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i += 1) {
      if (tracks[i].kind === 'captions' || tracks[i].kind === 'subtitles') {
        return tracks[i];
      }
    }
    return null;
  }

  return {
    get enabled() {
      return enabled;
    },

    attach(video: HTMLVideoElement) {
      const track = activeTrackOf(video);
      if (!track) return;

      track.mode = 'hidden';

      const onCueChange = () => {
        const cue = track.activeCues?.[0] as VTTCue | undefined;
        render(cue?.text ?? '');
      };

      track.addEventListener('cuechange', onCueChange);
      listeners.set(video, onCueChange);
    },

    detach(video: HTMLVideoElement) {
      const track = activeTrackOf(video);
      const handler = listeners.get(video);
      if (track && handler) track.removeEventListener('cuechange', handler);
      listeners.delete(video);
      render('');
    },

    setEnabled(next: boolean) {
      enabled = next;
      try {
        localStorage.setItem('presenter.captions', next ? '1' : '0');
      } catch {

      }
      if (!next) render('');
    },

    clear() {
      render('');
    },
  };
}

function readPreference(): boolean {
  try {
    return localStorage.getItem('presenter.captions') !== '0';
  } catch {
    return true;
  }
}
