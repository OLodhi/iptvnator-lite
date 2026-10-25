const EVENTS = ['play', 'pause', 'timeupdate', 'durationchange', 'progress', 'waiting', 'playing', 'ended', 'error', 'volumechange', 'seeked'] as const;

export type PlayerState = {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly waiting: boolean;
  readonly muted: boolean;
  /** Absolute position: the session's offset plus the element's currentTime. */
  readonly positionSec: number;
  /** The element's own duration, null while unknown or infinite (live). */
  readonly durationSec: number | null;
  /** The absolute seekable range, null when nothing is seekable yet. */
  readonly window: { startSec: number; endSec: number } | null;
  /** Live: seconds behind the end of the window; 0 when there is no window. */
  readonly behindSec: number;
  /** MediaError code, null when there is no error. */
  readonly error: number | null;
  destroy(): void;
};

/** Reactive view of a `<video>`: every field is refreshed from the element on its media events. */
export function createPlayerState(video: HTMLVideoElement, getOffset: () => number): PlayerState {
  let paused = $state(video.paused);
  let ended = $state(video.ended);
  let waiting = $state(false);
  let muted = $state(video.muted);
  let positionSec = $state(0);
  let durationSec = $state<number | null>(null);
  let window = $state<{ startSec: number; endSec: number } | null>(null);
  let live = $state(false);
  let error = $state<number | null>(null);

  function read(type?: string) {
    const offset = getOffset();
    paused = video.paused;
    ended = video.ended;
    muted = video.muted;
    positionSec = offset + (video.currentTime || 0);
    durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    live = video.duration === Infinity;
    const ranges = video.seekable;
    window = ranges && ranges.length > 0 ? { startSec: offset + ranges.start(0), endSec: offset + ranges.end(ranges.length - 1) } : null;
    error = video.error ? video.error.code : null;
    if (type === 'waiting') waiting = true;
    else if (type === 'playing' || type === 'pause' || type === 'ended' || type === 'error') waiting = false;
  }

  const onEvent = (e: Event) => read(e.type);
  for (const name of EVENTS) video.addEventListener(name, onEvent);
  read();

  return {
    get paused() { return paused; },
    get ended() { return ended; },
    get waiting() { return waiting; },
    get muted() { return muted; },
    get positionSec() { return positionSec; },
    get durationSec() { return durationSec; },
    get window() { return window; },
    // Live HLS reports duration Infinity; a VOD or a remux in progress has a seekable window but is not behind anything.
    get behindSec() { return live && window ? Math.max(0, window.endSec - positionSec) : 0; },
    get error() { return error; },
    destroy() {
      for (const name of EVENTS) video.removeEventListener(name, onEvent);
    },
  };
}
