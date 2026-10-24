import type { PositionReport } from '@tv/shared';

export type ProgressDeps = {
  report: (r: PositionReport) => Promise<void>;
  now: () => number;
  intervalMs?: number;
};

export type ProgressBase = {
  itemId: number;
  episodeRemoteId?: string;
  /** Where the HLS session started: the video's currentTime is relative to it. */
  startAtSec: number;
  durationSec: number | null;
};

const MIN_REPORT_SEC = 5; // the server ignores anything earlier

/**
 * Reports the absolute playback position (startAtSec + currentTime) on an interval and on flush().
 * Nothing is sent until playback has actually advanced (currentTime > 0) past the server's 5 s floor,
 * and a position is never sent twice. Failures are swallowed: progress is best-effort.
 */
export function createProgressReporter(deps: ProgressDeps) {
  const intervalMs = deps.intervalMs ?? 15_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let video: HTMLVideoElement | undefined;
  let base: ProgressBase | undefined;
  let lastSent = -1;
  let lastSentAt = 0;

  function send(): Promise<void> {
    if (!video || !base || !(video.currentTime > 0)) return Promise.resolve();
    const positionSec = Math.floor(base.startAtSec + video.currentTime);
    if (positionSec < MIN_REPORT_SEC || positionSec === lastSent) return Promise.resolve();
    lastSent = positionSec;
    lastSentAt = deps.now();
    const r: PositionReport = { itemId: base.itemId, positionSec, durationSec: base.durationSec };
    if (base.episodeRemoteId) r.episodeRemoteId = base.episodeRemoteId;
    return deps.report(r).catch(() => {});
  }

  function detach() {
    if (timer) clearInterval(timer);
    timer = undefined;
    video = undefined;
    base = undefined;
  }

  function attach(v: HTMLVideoElement, b: ProgressBase) {
    detach();
    video = v;
    base = b;
    lastSent = -1;
    lastSentAt = deps.now();
    timer = setInterval(() => {
      if (deps.now() - lastSentAt >= intervalMs / 2) void send(); // a flush just before the tick already covered it
    }, intervalMs);
  }

  return { attach, flush: send, detach };
}
