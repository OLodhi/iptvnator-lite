import type { PlayRequest, PlayResponse } from '@tv/shared';

export type PlaybackDeps = {
  play: (req: PlayRequest, signal: AbortSignal) => Promise<PlayResponse>;
  releaseSession: (sessionId: string, clientId: string) => Promise<void>;
  startHeartbeat: (sessionId: string, clientId: string, opts: { onGone: () => void }) => () => void;
  attachStream: (video: HTMLVideoElement, url: string) => { destroy(): void };
  clientId: () => string;
  onGone: () => void;
  /** Called once the stream is attached; startAtSec/durationSec come from the server. */
  onStarted?: (info: { startAtSec: number; durationSec: number | null }) => void;
  /** Called at the start of teardown of an attached session, before the video is detached. */
  onStopping?: () => void;
  onError: (err: unknown) => void;
};

export type StartParams = { itemId: number; episodeRemoteId?: string; startAtSec: number };

/**
 * Owns the play -> attach -> heartbeat -> release lifecycle. Only the latest start() may attach;
 * any /api/play response that arrives after teardown() or a newer start() is released, never attached.
 */
export function createPlayback(deps: PlaybackDeps) {
  let generation = 0;
  let controller: AbortController | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let handle: { destroy(): void } | undefined;
  let active: { sessionId: string; clientId: string; vod: boolean; startAtSec: number } | undefined;

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
    active = { sessionId: res.sessionId, clientId, vod: res.durationSec !== null, startAtSec: res.startAtSec };
    handle = deps.attachStream(video, res.url);
    stopHeartbeat = deps.startHeartbeat(res.sessionId, clientId, { onGone: deps.onGone });
    deps.onStarted?.({ startAtSec: res.startAtSec, durationSec: res.durationSec });
  }

  /** Absolute VOD position: the video's currentTime is relative to the session's start offset. */
  function absoluteSec(video: HTMLVideoElement): number {
    return Math.floor((active?.startAtSec ?? 0) + video.currentTime);
  }

  return { start, teardown, isVod: () => active?.vod ?? false, absoluteSec };
}
