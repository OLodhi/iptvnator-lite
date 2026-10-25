import type { PlayRequest, PlayResponse } from '@tv/shared';

export type PlaybackDeps = {
  play: (req: PlayRequest, signal: AbortSignal) => Promise<PlayResponse>;
  releaseSession: (sessionId: string, clientId: string) => Promise<void>;
  startHeartbeat: (sessionId: string, clientId: string, opts: { onGone: () => void }) => () => void;
  /** `startAtSec`: for a direct stream, where to seek once the file is open (an HLS session starts there itself). */
  attachStream: (video: HTMLVideoElement, url: string, opts: { startAtSec?: number }) => { destroy(): void };
  clientId: () => string;
  onGone: () => void;
  /** Called once the stream is attached; durationSec comes from the server. */
  onStarted?: (info: {
    /** Added to currentTime to get the absolute position; 0 when the stream itself is absolute. */
    offsetSec: number;
    durationSec: number | null;
  }) => void;
  /** Called at the start of teardown of an attached session, before the video is detached. */
  onStopping?: () => void;
  onError: (err: unknown) => void;
};

export type StartParams = { itemId: number; episodeRemoteId?: string; startAtSec: number; catchup?: { startSec: number; stopSec: number } };

/**
 * Owns the play -> attach -> heartbeat -> release lifecycle. Only the latest start() may attach;
 * any /api/play response that arrives after teardown() or a newer start() is released, never attached.
 */
export function createPlayback(deps: PlaybackDeps) {
  let generation = 0;
  let controller: AbortController | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let handle: { destroy(): void } | undefined;
  let active: { sessionId: string; clientId: string; vod: boolean; offsetSec: number } | undefined;

  function teardown() {
    if (active) deps.onStopping?.();
    generation++;
    controller?.abort();
    controller = undefined;
    stopHeartbeat?.();
    stopHeartbeat = undefined;
    handle?.destroy();
    handle = undefined;
    if (active) {
      void deps.releaseSession(active.sessionId, active.clientId);
      active = undefined;
    }
  }

  async function start(params: StartParams, video: HTMLVideoElement): Promise<void> {
    teardown();
    const mine = generation;
    const clientId = deps.clientId();
    const ctl = (controller = new AbortController());
    const req: PlayRequest = { itemId: params.itemId, startAtSec: params.startAtSec, clientId };
    if (params.episodeRemoteId) req.episodeRemoteId = params.episodeRemoteId;
    if (params.catchup) req.catchup = params.catchup;
    let res: PlayResponse;
    try {
      res = await deps.play(req, ctl.signal);
    } catch (err) {
      if (mine === generation) deps.onError(err);
      return;
    }
    if (mine !== generation) {
      void deps.releaseSession(res.sessionId, clientId);
      return;
    }
    // An HLS session is cut from startAtSec, so its currentTime counts from there. A direct stream is the whole
    // file: it is seeked to startAtSec instead, and its currentTime is already absolute.
    const offsetSec = res.mode === 'hls' ? res.startAtSec : 0;
    const seekToSec = res.mode === 'direct' && res.startAtSec > 0 ? res.startAtSec : undefined;
    active = { sessionId: res.sessionId, clientId, vod: res.durationSec !== null, offsetSec };
    handle = deps.attachStream(video, res.url, seekToSec === undefined ? {} : { startAtSec: seekToSec });
    stopHeartbeat = deps.startHeartbeat(res.sessionId, clientId, { onGone: deps.onGone });
    deps.onStarted?.({ offsetSec, durationSec: res.durationSec });
  }

  /** Absolute VOD position: currentTime plus the session's offset (0 for a direct stream). */
  function absoluteSec(video: HTMLVideoElement): number {
    return Math.floor((active?.offsetSec ?? 0) + video.currentTime);
  }

  return { start, teardown, isVod: () => active?.vod ?? false, absoluteSec };
}
