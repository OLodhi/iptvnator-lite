import type { PlayRequest, PlayResponse, SessionTracks } from '@tv/shared';
import type { StreamHandle } from './attach.ts';
import { seekWhenOpen } from './seekWhenOpen.ts';

/** A seek never lands closer than this to the end, so it can't end playback the moment it arrives. */
const END_MARGIN_SEC = 5;
/** A catch-up seek stays this far behind now, so its window has aired and the provider has it. */
const NOW_MARGIN_SEC = 30;
/** Catch-up windows start on a whole minute: the provider's timeshift URLs count in minutes. */
const MINUTE_SEC = 60;

export type PlaybackDeps = {
  play: (req: PlayRequest, signal: AbortSignal) => Promise<PlayResponse>;
  releaseSession: (sessionId: string, clientId: string) => Promise<void>;
  startHeartbeat: (sessionId: string, clientId: string, opts: { onGone: () => void }) => () => void;
  /**
   * `startAtSec`: for a direct stream, where to seek once the file is open (an HLS session starts there itself).
   * `vod`: anything but live.
   */
  attachStream: (video: HTMLVideoElement, url: string, opts: { startAtSec?: number; vod: boolean }) => StreamHandle;
  clientId: () => string;
  /** The clock, in ms; Date.now when left out. */
  now?: () => number;
  onGone: () => void;
  /** Called once the stream is attached; durationSec comes from the server. */
  onStarted?: (info: {
    /** Added to currentTime to get the absolute position; 0 when the stream itself is absolute. */
    offsetSec: number;
    durationSec: number | null;
    mode: PlayResponse['mode'];
    tracks: SessionTracks | null;
    handle: StreamHandle;
  }) => void;
  /** Called at the start of teardown of an attached session, before the video is detached. */
  onStopping?: () => void;
  /** Called as a seek or a track change restarts the session: nothing plays until the new one does. */
  onRestarting?: () => void;
  onError: (err: unknown) => void;
};

export type StartParams = {
  kind: 'live' | 'catchup' | 'movie' | 'episode';
  itemId: number;
  episodeRemoteId?: string;
  /** Where to start: seconds into the movie or episode, or into the catch-up programme. */
  startAtSec: number;
  /** The whole catch-up programme. A later start inside it is reached through a window that starts on its minute. */
  catchup?: { startSec: number; stopSec: number };
  audioIndex?: number;
  subtitleIndex?: number | null;
  subtitleLanguage?: string | null;
};

/** The attached session. Positions are absolute: currentTime + offsetSec. */
export type CurrentPlayback = {
  params: StartParams;
  offsetSec: number;
  /** The whole movie, episode or catch-up programme, when known. */
  durationSec: number | null;
  mode: PlayResponse['mode'];
  tracks: SessionTracks | null;
};

/** Where the catch-up window for a start at `startAtSec` begins, in seconds after the programme's own start. */
function windowShiftSec(startAtSec: number): number {
  return Math.floor(startAtSec / MINUTE_SEC) * MINUTE_SEC;
}

function playRequest(params: StartParams, clientId: string): PlayRequest {
  // A catch-up window carries its own position, so the stream starts at its beginning.
  const req: PlayRequest = { itemId: params.itemId, startAtSec: params.catchup ? 0 : params.startAtSec, clientId };
  if (params.episodeRemoteId) req.episodeRemoteId = params.episodeRemoteId;
  if (params.catchup) {
    req.catchup = { startSec: params.catchup.startSec + windowShiftSec(params.startAtSec), stopSec: params.catchup.stopSec };
  }
  if (params.audioIndex !== undefined) req.audioIndex = params.audioIndex;
  if (params.subtitleIndex !== undefined) req.subtitleIndex = params.subtitleIndex;
  if (params.subtitleLanguage !== undefined) req.subtitleLanguage = params.subtitleLanguage;
  return req;
}

/**
 * Owns the play -> attach -> heartbeat -> release lifecycle. Only the latest start may attach; any /api/play
 * response that arrives after teardown() or a newer start (including a seek or track restart) is released, never attached.
 */
export function createPlayback(deps: PlaybackDeps) {
  let generation = 0;
  let controller: AbortController | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let handle: StreamHandle | undefined;
  let cancelSeek: (() => void) | undefined;
  /** The latest start until teardown, attached or not; durationSec is kept across its seek and track restarts. */
  let latest: { params: StartParams; durationSec: number | null } | undefined;
  /** The attached session; startSec is the absolute position it starts at. */
  let active: (CurrentPlayback & { sessionId: string; clientId: string; startSec: number }) | undefined;

  /** Ends the attached or in-flight session. */
  function stop() {
    if (active) deps.onStopping?.();
    generation++;
    controller?.abort();
    controller = undefined;
    cancelSeek?.();
    cancelSeek = undefined;
    stopHeartbeat?.();
    stopHeartbeat = undefined;
    handle?.destroy();
    handle = undefined;
    if (active) {
      void deps.releaseSession(active.sessionId, active.clientId);
      active = undefined;
    }
  }

  function teardown() {
    stop();
    latest = undefined;
  }

  async function begin(params: StartParams, video: HTMLVideoElement, durationSec: number | null): Promise<void> {
    stop();
    const want = (latest = { params, durationSec });
    const mine = generation;
    const clientId = deps.clientId();
    const ctl = (controller = new AbortController());
    let res: PlayResponse;
    try {
      res = await deps.play(playRequest(params, clientId), ctl.signal);
    } catch (err) {
      if (mine === generation) deps.onError(err);
      return;
    }
    if (mine !== generation) {
      void deps.releaseSession(res.sessionId, clientId);
      return;
    }
    // An HLS session is cut from res.startAtSec, so its currentTime counts from there. A direct stream is the whole
    // file: it is seeked to res.startAtSec instead, and its currentTime is already absolute. A catch-up window starts
    // on its minute, is seeked the rest of the way, and its duration is counted from that minute.
    let offsetSec = res.mode === 'hls' ? res.startAtSec : 0;
    let startSec = res.startAtSec;
    let duration = res.durationSec;
    if (params.catchup) {
      offsetSec = windowShiftSec(params.startAtSec);
      startSec = params.startAtSec;
      if (duration !== null) duration += offsetSec;
    }
    const seekSec = startSec - offsetSec;
    want.durationSec = duration;
    active = { sessionId: res.sessionId, clientId, params, offsetSec, durationSec: duration, mode: res.mode, tracks: res.tracks, startSec };
    const vod = params.kind !== 'live';
    const direct = res.mode === 'direct';
    const stream = (handle = deps.attachStream(video, res.url, direct && seekSec > 0 ? { vod, startAtSec: seekSec } : { vod }));
    if (!direct && seekSec > 0) cancelSeek = seekWhenOpen(video, seekSec);
    stopHeartbeat = deps.startHeartbeat(res.sessionId, clientId, { onGone: deps.onGone });
    deps.onStarted?.({ offsetSec, durationSec: duration, mode: res.mode, tracks: res.tracks, handle: stream });
  }

  /** Starts playing, after ending whatever was playing. A catch-up programme's length is known before the server answers. */
  function start(params: StartParams, video: HTMLVideoElement): Promise<void> {
    return begin(params, video, params.catchup ? params.catchup.stopSec - params.catchup.startSec : null);
  }

  /**
   * The absolute position: currentTime plus the session's offset. Until the stream is open its currentTime says
   * nothing (a direct file isn't seeked yet), so this is where it is starting.
   */
  function absoluteSec(video: HTMLVideoElement): number {
    if (active && video.readyState >= HTMLMediaElement.HAVE_METADATA) return Math.floor(active.offsetSec + video.currentTime);
    return Math.floor(active?.startSec ?? latest?.params.startAtSec ?? 0);
  }

  /** Where a seek or restart to `absSec` may go: from 0 to 5 s short of the end, and for a programme still airing 30 s short of now. */
  function clamp(absSec: number, { params, durationSec }: NonNullable<typeof latest>): number {
    let latestSec = durationSec === null ? Infinity : durationSec - END_MARGIN_SEC;
    // The server refuses a window that starts after now, and the playing session would already be gone.
    if (params.catchup) latestSec = Math.min(latestSec, (deps.now ?? Date.now)() / 1000 - params.catchup.startSec - NOW_MARGIN_SEC);
    return Math.max(0, Math.min(absSec, latestSec));
  }

  /**
   * Seeks to an absolute position, kept 5 s short of the end, and for a programme still airing 30 s short of now.
   * What has been remuxed so far is seeked within; anything else restarts a movie, episode or catch-up programme there.
   */
  async function seekTo(video: HTMLVideoElement, absSec: number): Promise<void> {
    if (!latest) return;
    const { params, durationSec } = latest;
    const target = clamp(absSec, latest);
    if (active) {
      const ranges = video.seekable;
      const loadedEndSec = active.offsetSec + (ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
      if (target >= active.offsetSec && target <= loadedEndSec) {
        video.currentTime = target - active.offsetSec;
        return;
      }
    }
    if (params.kind === 'live') return;
    deps.onRestarting?.();
    return begin({ ...params, startAtSec: target }, video, durationSec);
  }

  /** Restarts at the current position with other tracks, kept short of the end as a seek is. */
  function restartWith(
    video: HTMLVideoElement,
    patch: Partial<Pick<StartParams, 'audioIndex' | 'subtitleIndex' | 'subtitleLanguage'>>,
  ): Promise<void> {
    if (!latest) return Promise.resolve();
    deps.onRestarting?.();
    return begin({ ...latest.params, ...patch, startAtSec: clamp(absoluteSec(video), latest) }, video, latest.durationSec);
  }

  function current(): CurrentPlayback | null {
    if (!active) return null;
    const { params, offsetSec, durationSec, mode, tracks } = active;
    return { params, offsetSec, durationSec, mode, tracks };
  }

  return {
    start,
    teardown,
    /** True for everything but live, even when the duration isn't known. */
    isVod: () => latest !== undefined && latest.params.kind !== 'live',
    absoluteSec,
    seekTo,
    restartWith,
    current,
  };
}
