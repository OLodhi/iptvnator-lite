import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PlayResponse } from '@tv/shared';
import { redactUrl } from '../util/redact.ts';
import { buildFfmpegArgs, isHlsUrl } from './ffmpegArgs.ts';
import { choosePlan } from './policy.ts';
import type { HlsPlan } from './policy.ts';
import type { ProbeResult, Prober } from './probe.ts';
import type { UpstreamRelay } from './relay.ts';

export type ChildLike = {
  pid?: number;
  kill(): boolean;
  once(event: 'exit', cb: (code: number | null) => void): unknown;
  stderr: NodeJS.ReadableStream | null;
};

export type SessionManagerDeps = {
  ffmpegPath: string;
  transcodeDir: string;
  /**
   * A real implementation must listen for the child's 'error' event: a spawn that fails
   * (e.g. ENOENT) emits 'error' and never 'exit', and leaves `pid` undefined.
   */
  spawn: (cmd: string, args: string[]) => ChildLike;
  probe: Prober['probe'];
  /** R34: called for each probe that came from the cache when the start fails, or the live session gives up. */
  invalidateProbe: Prober['invalidate'];
  transcodeInterlaced: boolean;
  maxConnections: (providerId: number) => number | null;
  isReady: (outDir: string) => Promise<boolean>;
  now: () => number;
  liveIdleMs: number /* 20_000, per viewer */;
  vodIdleMs: number /* 60_000, per viewer */;
  readyTimeoutMs: number /* 15_000, covering probe + spawn + first segment */;
  maxRestarts: number /* 3 consecutive */;
  stallTimeoutMs: number /* 20_000 without a new live segment */;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  /**
   * Non-HLS VOD is probed, and read by FFmpeg, through it, so neither ffprobe's seeks nor FFmpeg's ever open a second
   * provider connection. Left out, both read the provider.
   */
  relay?: Pick<UpstreamRelay, 'register'>;
};

export type StartRequest = {
  providerId: number;
  /** Catch-up plays like a VOD title (per viewer, read through the relay), from its start. */
  kind: 'live' | 'movie' | 'episode' | 'catchup';
  contentKey: string;
  sourceUrl: string;
  /** Live only: the provider's continuous stream, used instead if `sourceUrl` is a finite playlist (R29). */
  fallbackSourceUrl?: string;
  /** The title's duration, when known better than its probe can tell (a catch-up programme's length). */
  durationHintSec?: number;
  userAgent: string;
  /** Ignored for live and catch-up. */
  startAtSec: number;
  clientId: string;
  quality: 'original';
};

/** `url` is `/api/sessions/<sessionId>/<clientId>/index.m3u8` or `/api/sessions/<sessionId>/<clientId>/direct`. */
export type StartedSession = PlayResponse;

export type PlaybackErrorCode = 'PROVIDER_CONNECTION_LIMIT' | 'STREAM_START_TIMEOUT' | 'UPSTREAM_ERROR';

export class PlaybackError extends Error {
  code: PlaybackErrorCode;
  details?: { limit: number; watchingClientIds: string[] };

  constructor(code: PlaybackErrorCode, message: string, details?: { limit: number; watchingClientIds: string[] }) {
    super(message);
    this.name = 'PlaybackError';
    this.code = code;
    if (details) this.details = details;
  }
}

export interface SessionManager {
  /** Rejects with a plain Error (not a PlaybackError) if `clientId` doesn't match CLIENT_ID. */
  start(req: StartRequest): Promise<StartedSession>;
  /** Marks a viewer as still watching, re-adding them if needed; false if the session is gone. */
  touch(sessionId: string, clientId: string): boolean;
  release(sessionId: string, clientId: string): Promise<void>;
  resolveFile(sessionId: string, file: string): string | null;
  directSource(sessionId: string): { url: string; userAgent: string } | null;
  activeUpstreams(providerId: number): number;
  reap(): Promise<void>;
  stopAll(): Promise<void>;
}

export const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const READY_POLL_MS = 200;
const HOUSEKEEPING_MS = 5_000;
// FFmpeg hard-exits after more than three termination signals, so re-signalling a stuck one ends it.
const KILL_RETRY_MS = 2_000;
const RESTART_BACKOFF_MS = 1_000; // doubles per consecutive restart: 1 s, 2 s, 4 s
const HEALTHY_RESET_MS = 60_000; // a live process producing segments this long earns back its restart budget
// R28/R28a: a live process that wrote this many new segments and ran this long before exiting (a
// provider playlist that "ends", a transient write error) was working: relaunch it at once and forgive
// earlier failures. Anything quicker is a failure, so an input read faster than real time can't tight-loop.
const RECONNECT_MIN_SEGMENTS = 2;
const RECONNECT_MIN_RUN_MS = 10_000;
// R33: a relaunched live FFmpeg writes a fresh playlist, and delete_segments only removes what that run
// listed, so the session deletes the previous runs' segments itself. It waits this long after the new
// playlist appears (checked on each housekeeping pass), for players still fetching the old run's last ones.
const OLD_SEGMENT_GRACE_MS = 10_000;
const SEGMENT_FILE = /^seg_(\d+)\.(?:ts|m4s)$/;
// A plain file name: no separators, no drive or stream colons, not '.' or '..'.
const PLAIN_FILE = /^[\w-][\w.-]*$/;
// Session dirs are named by randomUUID(); nothing else in transcodeDir is ever removed.
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Deletes the segment files (`seg_<n>.ts` / `seg_<n>.m4s`) in `outDir` numbered below `below`; nothing
 * else (`init.mp4`, the playlist) is touched. A missing directory has nothing to delete; a file that
 * can't be deleted is counted in `failed` and left for a later pass or the session's end.
 */
export function pruneSegments(outDir: string, below: number): { deleted: number; failed: number } {
  let names: string[];
  try {
    names = readdirSync(outDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: 0, failed: 0 };
    throw err;
  }
  let deleted = 0;
  let failed = 0;
  for (const name of names) {
    const m = SEGMENT_FILE.exec(name);
    if (!m || Number(m[1]) >= below) continue;
    try {
      rmSync(join(outDir, name), { force: true });
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}

/** True once FFmpeg has written a playlist that lists at least one segment. */
export async function defaultIsReady(outDir: string): Promise<boolean> {
  try {
    return (await readFile(join(outDir, 'index.m3u8'), 'utf8')).includes('#EXTINF');
  } catch {
    return false;
  }
}

type Session = {
  id: string;
  key: string;
  providerId: number;
  kind: StartRequest['kind'];
  sourceUrl: string; // what FFmpeg reads: the requested URL, or its continuous fallback (R29)
  userAgent: string;
  startAtSec: number;
  // starting: probing/spawning, not yet joinable; running: registered; stopping: on its way out.
  state: 'starting' | 'running' | 'stopping';
  mode: 'hls' | 'direct';
  durationHintSec: number | null;
  durationSec: number | null;
  plan: HlsPlan | null;
  inputFormat: string; // ffprobe's format_name for the source
  outDir: string | null;
  child: ChildLike | null;
  exit: Promise<number | null> | null; // resolves when the current child exits
  relayed: { url: string; unregister(): Promise<void> } | null; // what ffprobe and FFmpeg read instead of sourceUrl
  probing: Promise<void> | null; // an ffprobe that is still connected
  cachedProbes: string[]; // URLs whose probe results came from the cache (R34)
  restarts: number; // consecutive failures
  restartTimer: ReturnType<typeof setTimeout> | null;
  launchSegment: number; // highest segment before the current process started (its start number - 1)
  launchedAt: number; // when the current process started
  stalled: boolean; // the watchdog killed the current process
  lastSegment: number; // live watchdog: highest segment seen,
  advancedAt: number; // when it last went up,
  healthySince: number | null; // and when the current process first produced one
  // R33, one per relaunch: delete segments numbered below `below` once a playlist lists one at or above
  // it (the new run's, first seen at `seenAt`) and the grace has passed.
  prunes: { below: number; seenAt: number | null }[];
  clients: Map<string, number>; // viewer → last seen
  stopped: Promise<void> | null;
};

const errorText = (err: unknown) => redactUrl(err instanceof Error ? err.message : String(err));
const stoppedError = () => new PlaybackError('UPSTREAM_ERROR', 'Playback was stopped');

function lastSegment(outDir: string): number {
  let playlist: string;
  try {
    playlist = readFileSync(join(outDir, 'index.m3u8'), 'utf8');
  } catch {
    return -1;
  }
  let last = -1;
  for (const m of playlist.matchAll(/seg_(\d+)/g)) last = Math.max(last, Number(m[1]));
  return last;
}

/** One start deadline: `expired` rejects with STREAM_START_TIMEOUT unless cleared first. */
function startDeadline(ms: number): { expired: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const error = new PlaybackError('STREAM_START_TIMEOUT', `The stream did not start within ${ms} ms`);
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  expired.catch(() => {});
  return { expired, clear: () => clearTimeout(timer) };
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { log } = deps;
  const sessions = new Map<string, Session>(); // running sessions, by id
  const starting = new Map<string, { session: Session; done: Promise<void> }>(); // in-flight starts, by key
  const dying = new Map<Session, Promise<void>>(); // until FFmpeg has exited and any probe has ended
  const clientQueues = new Map<string, Promise<void>>();
  let closed = false;

  removeSessionDirs();
  const housekeeping = setInterval(() => {
    void reap(); // first, so the watchdog doesn't restart what nobody watches
    watchdog();
    pruneOldRuns();
  }, HOUSEKEEPING_MS);
  housekeeping.unref();

  function removeSessionDirs(): void {
    try {
      mkdirSync(deps.transcodeDir, { recursive: true });
      for (const entry of readdirSync(deps.transcodeDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !SESSION_DIR.test(entry.name)) continue;
        rmSync(join(deps.transcodeDir, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    } catch (err) {
      log.warn({ dir: deps.transcodeDir, err: errorText(err) }, 'could not clear old session dirs');
    }
  }

  async function removeDir(dir: string): Promise<void> {
    try {
      // On Windows a just-exited FFmpeg can hold its files for a moment.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      log.warn({ dir, err: errorText(err) }, 'could not remove session dir');
    }
  }

  const startingSessions = () => [...starting.values()].map((e) => e.session);
  const holdsUpstream = (s: Session) =>
    s.state === 'starting' || s.mode === 'direct' || s.child !== null || s.probing !== null || s.restartTimer !== null;

  /** Sessions that hold (or are about to reopen) a provider connection. */
  function upstreamHolders(providerId: number): Session[] {
    const all = new Set<Session>([...sessions.values(), ...startingSessions(), ...dying.keys()]);
    return [...all].filter((s) => s.providerId === providerId && holdsUpstream(s));
  }

  function connectionLimit(providerId: number): number | null {
    const limit = deps.maxConnections(providerId);
    return limit !== null && limit > 0 ? limit : null; // a reported 0 is treated as "no limit"
  }

  function toResponse(s: Session, clientId: string): StartedSession {
    const file = s.mode === 'hls' ? 'index.m3u8' : 'direct';
    const { id: sessionId, mode, durationSec, startAtSec } = s;
    return { sessionId, mode, url: `/api/sessions/${sessionId}/${clientId}/${file}`, durationSec, startAtSec };
  }

  function stopSession(s: Session, reason: string): Promise<void> {
    if (s.stopped) return s.stopped;
    s.state = 'stopping';
    sessions.delete(s.id);
    s.clients.clear();
    clearTimeout(s.restartTimer ?? undefined);
    s.restartTimer = null;
    s.prunes = []; // the whole directory is about to go
    const stopped = (async () => {
      await killAndWait(s);
      await s.relayed?.unregister(); // the provider connection FFmpeg read through is closed
      if (s.outDir) await removeDir(s.outDir);
      log.info({ sessionId: s.id, reason }, 'session stopped');
    })();
    s.stopped = stopped;
    // It counts against the provider's limit until FFmpeg has exited and any probe has ended.
    dying.set(
      s,
      Promise.all([stopped, s.probing]).then(() => {
        dying.delete(s);
      }),
    );
    return stopped;
  }

  async function killAndWait(s: Session): Promise<void> {
    const { child, exit } = s;
    if (!child || !exit) return;
    child.kill();
    const retry = setInterval(() => {
      log.warn({ sessionId: s.id, pid: child.pid }, 'ffmpeg has not exited; signalling again');
      child.kill();
    }, KILL_RETRY_MS);
    retry.unref();
    try {
      await exit;
    } finally {
      clearInterval(retry);
    }
  }

  function launch(s: Session, startNumber: number): void {
    const args = buildFfmpegArgs({
      url: s.relayed?.url ?? s.sourceUrl,
      userAgent: s.userAgent,
      plan: s.plan!,
      inputFormat: s.inputFormat,
      live: s.kind === 'live',
      startAtSec: s.startAtSec,
      outDir: s.outDir!,
      startNumber,
    });
    const child = deps.spawn(deps.ffmpegPath, args);
    // No pid means the spawn itself failed; such a child never emits 'exit'.
    const exit =
      child.pid === undefined
        ? Promise.resolve(null)
        : new Promise<number | null>((resolve) => child.once('exit', resolve));
    s.child = child;
    s.exit = exit;
    // Progress is measured from here: the previous process's segments are not this one's.
    s.launchSegment = startNumber - 1;
    s.lastSegment = startNumber - 1;
    s.stalled = false;
    s.launchedAt = deps.now();
    s.advancedAt = s.launchedAt;
    s.healthySince = null;
    if (child.stderr) {
      const lines = createInterface({ input: child.stderr, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (line.trim()) log.warn({ sessionId: s.id, line: redactUrl(line) }, 'ffmpeg');
      });
      lines.on('error', () => {});
    }
    void exit.then((code) => {
      if (s.child === child) s.child = null;
      // While starting, waitUntilReady handles the exit; while stopping, killAndWait does.
      if (s.state === 'running') onRunningExit(s, code);
    });
  }

  function onRunningExit(s: Session, code: number | null): void {
    if (s.kind !== 'live') {
      // A VOD FFmpeg exits once it has written the whole title; its segments stay servable.
      if (code === 0) log.info({ sessionId: s.id }, 'ffmpeg finished');
      else log.warn({ sessionId: s.id, code }, 'ffmpeg exited early');
      return;
    }
    // Read the playlist now: the watchdog samples only every few seconds.
    const highest = Math.max(s.lastSegment, lastSegment(s.outDir!));
    const segments = highest - s.launchSegment;
    const ranMs = deps.now() - s.launchedAt;
    // A stall kill means no recent progress, whatever the process wrote before.
    if (!s.stalled && segments >= RECONNECT_MIN_SEGMENTS && ranMs >= RECONNECT_MIN_RUN_MS) {
      log.info({ sessionId: s.id, code, segments, ranMs }, 'ffmpeg exited after producing segments; reconnecting');
      s.restarts = 0;
      relaunch(s, highest + 1);
      return;
    }
    if (s.restarts >= deps.maxRestarts) {
      log.warn({ sessionId: s.id, code, restarts: s.restarts }, 'ffmpeg keeps exiting; giving up');
      forgetCachedProbes(s);
      void stopSession(s, 'upstream failed');
      return;
    }
    s.restarts++;
    const delayMs = RESTART_BACKOFF_MS * 2 ** (s.restarts - 1);
    log.warn({ sessionId: s.id, code, restart: s.restarts, delayMs }, 'ffmpeg exited; restarting');
    s.restartTimer = setTimeout(() => {
      s.restartTimer = null;
      if (s.state !== 'running') return;
      relaunch(s, Math.max(s.lastSegment, lastSegment(s.outDir!)) + 1);
    }, delayMs);
    s.restartTimer.unref();
  }

  /** Starts the next live process, continuing the segment numbers; a spawn that throws ends the session. */
  function relaunch(s: Session, startNumber: number): void {
    try {
      launch(s, startNumber);
    } catch (err) {
      log.warn({ sessionId: s.id, err: errorText(err) }, 'ffmpeg restart failed');
      void stopSession(s, 'upstream failed');
      return;
    }
    // Each relaunch gets its own pass, so runs shorter than the grace still get their predecessors deleted.
    s.prunes.push({ below: startNumber, seenAt: null });
  }

  /** R33: deletes the segments earlier live runs left behind, once the newer playlist is up and the grace is over. */
  function pruneOldRuns(): void {
    const now = deps.now();
    for (const s of sessions.values()) {
      if (s.prunes.length === 0 || !s.outDir) continue;
      const newest = lastSegment(s.outDir);
      let below = -1;
      s.prunes = s.prunes.filter((p) => {
        if (p.seenAt === null) {
          if (newest < p.below) return true; // players are still on the old playlist
          p.seenAt = now;
        }
        if (now - p.seenAt < OLD_SEGMENT_GRACE_MS) return true;
        below = Math.max(below, p.below);
        return false;
      });
      if (below < 0) continue;
      try {
        const { deleted, failed } = pruneSegments(s.outDir, below);
        if (deleted > 0) log.info({ sessionId: s.id, below, deleted }, 'removed old segments');
        if (failed > 0) log.warn({ sessionId: s.id, below, failed }, 'could not remove some old segments');
      } catch (err) {
        log.warn({ sessionId: s.id, err: errorText(err) }, 'could not remove old segments');
      }
    }
  }

  /** Kills a live FFmpeg that is alive but no longer producing segments; the restart path takes over. */
  function watchdog(): void {
    const now = deps.now();
    for (const s of sessions.values()) {
      if (s.kind !== 'live' || !s.child) continue;
      const last = lastSegment(s.outDir!);
      if (last > s.lastSegment) {
        s.lastSegment = last;
        s.advancedAt = now;
        s.healthySince ??= now;
      }
      if (s.restarts > 0 && s.healthySince !== null && now - s.healthySince >= HEALTHY_RESET_MS) {
        log.info({ sessionId: s.id, restarts: s.restarts }, 'live stream healthy again');
        s.restarts = 0;
      }
      if (now - s.advancedAt >= deps.stallTimeoutMs) {
        const url = redactUrl(s.sourceUrl);
        log.warn({ sessionId: s.id, url, lastSegment: s.lastSegment }, 'live stream stalled; restarting ffmpeg');
        s.advancedAt = now;
        s.stalled = true;
        void killAndWait(s);
      }
    }
  }

  function waitUntilReady(s: Session, expired: Promise<never>): Promise<void> {
    const outDir = s.outDir!;
    const ready = () => deps.isReady(outDir).catch(() => false);
    return new Promise((resolve, reject) => {
      let settled = false;
      let poll: ReturnType<typeof setTimeout> | undefined;
      function settle(err: unknown): void {
        if (settled) return;
        settled = true;
        clearTimeout(poll);
        if (err) reject(err);
        else resolve();
      }
      async function check(): Promise<void> {
        const ok = await ready();
        if (settled) return;
        if (ok) settle(null);
        else poll = setTimeout(check, READY_POLL_MS);
      }
      expired.catch(settle);
      // A short VOD remux can finish between polls, so look once more before calling it a failure.
      void s.exit!.then(async () => {
        if (settled) return;
        const ok = await ready();
        settle(ok ? null : new PlaybackError('UPSTREAM_ERROR', 'FFmpeg exited before the stream was ready'));
      });
      void check();
    });
  }

  /** R34: a failure after a cached probe may be the cache's fault (a stale format, audio index or placeholder), so it goes. */
  function forgetCachedProbes(s: Session): void {
    for (const url of s.cachedProbes.splice(0)) {
      try {
        deps.invalidateProbe(url);
        log.info({ sessionId: s.id, url: redactUrl(url) }, 'forgot cached probe');
      } catch (err) {
        log.warn({ sessionId: s.id, url: redactUrl(url), err: errorText(err) }, 'could not forget cached probe');
      }
    }
  }

  /**
   * Probes `url` (reading it from `readFrom` if given), tracked as a held connection, racing the start deadline; a probe
   * error passes through as is.
   */
  function probeRace(s: Session, url: string, expired: Promise<never>, readFrom?: string): Promise<ProbeResult> {
    // A timeshift URL is unique per programme start, so a cached probe would never be hit and would only grow probe_cache.
    const opts = { skipCache: s.kind === 'catchup' };
    const probing = deps.probe(url, s.userAgent, readFrom, opts).then(({ result, cached }) => {
      if (cached) s.cachedProbes.push(url);
      return result;
    });
    const done = () => {
      if (s.probing === ended) s.probing = null;
    };
    const ended = probing.then(done, done);
    s.probing = ended;
    return Promise.race([probing, expired]);
  }

  async function probeWithin(s: Session, url: string, expired: Promise<never>): Promise<ProbeResult> {
    try {
      return await probeRace(s, url, expired);
    } catch (err) {
      if (err instanceof PlaybackError) throw err; // the deadline
      log.warn({ url: redactUrl(url), err: errorText(err) }, 'probe failed');
      throw new PlaybackError('UPSTREAM_ERROR', 'The stream could not be opened');
    }
  }

  /** Ends the session's relay registration, once the provider connection it held is closed. */
  async function letGoOfRelay(s: Session): Promise<void> {
    if (!s.relayed) return;
    await s.relayed.unregister();
    s.relayed = null; // only now: a stop meanwhile also waits for the connection to close
  }

  /**
   * Probes the source, through the session's relay registration if it has one. A source the relay cannot serve (HLS
   * behind a non-.m3u8 URL, whose relative segment URLs do not resolve through it) is probed from the provider
   * instead, once, and the session no longer uses the relay.
   */
  async function probeSource(s: Session, expired: Promise<never>): Promise<ProbeResult> {
    if (!s.relayed) return probeWithin(s, s.sourceUrl, expired);
    try {
      return await probeRace(s, s.sourceUrl, expired, s.relayed.url);
    } catch (err) {
      if (err instanceof PlaybackError) throw err; // the deadline
      const url = redactUrl(s.sourceUrl);
      log.info({ sessionId: s.id, url, err: errorText(err) }, 'probe through the relay failed; probing the provider directly');
      await letGoOfRelay(s); // its provider request is closed before the next one opens
      if (s.state !== 'starting') throw stoppedError();
      return probeWithin(s, s.sourceUrl, expired);
    }
  }

  /** R29: a live HLS input with a duration is an ENDLIST playlist, which FFmpeg reads to the end and leaves. */
  const finitePlaylist = (s: Session, probe: ProbeResult) =>
    s.kind === 'live' && probe.formatName.includes('hls') && probe.durationSec !== null;

  /** Switches the session to the provider's continuous stream, unless that can't be probed (within the same deadline). */
  async function continuousInstead(s: Session, playlist: ProbeResult, url: string, expired: Promise<never>): Promise<ProbeResult> {
    const sessionId = s.id;
    const fallback = redactUrl(url);
    const { durationSec } = playlist;
    log.info({ sessionId, url: redactUrl(s.sourceUrl), fallback, durationSec }, 'trying the continuous stream');
    const notUsed = (reason: string) => {
      log.warn({ sessionId, fallback, reason }, 'continuous stream not used; playing the playlist');
      return playlist;
    };
    let probe: ProbeResult;
    try {
      probe = await probeRace(s, url, expired);
    } catch (err) {
      if (err instanceof PlaybackError) throw err; // the deadline
      return notUsed(errorText(err));
    }
    // Only an actual stream will do. Some servers answer every live extension with the same playlist,
    // and HLS behind a non-.m3u8 URL would also be read without -http_multiple 0.
    if (probe.formatName.includes('hls')) return notUsed('fallback is also HLS');
    s.sourceUrl = url;
    log.info({ sessionId, url: fallback }, 'switched to continuous stream');
    return probe;
  }

  async function open(s: Session, fallbackUrl: string | undefined): Promise<void> {
    const deadline = startDeadline(deps.readyTimeoutMs); // probes + spawn + ready, all together
    try {
      // Through the relay from the probe on: ffprobe seeks as FFmpeg does (to an MP4's moov atom at the end of the
      // file, say), and a one-connection provider refuses the second request. Not for live, which never seeks, nor
      // for HLS, which is read over one connection (-http_multiple 0) and whose relative segment URLs would not
      // resolve through the relay.
      if (deps.relay && s.kind !== 'live' && !isHlsUrl(s.sourceUrl)) {
        s.relayed = deps.relay.register({ url: s.sourceUrl, userAgent: s.userAgent });
      }
      let probe = await probeSource(s, deadline.expired);
      if (s.state !== 'starting') throw stoppedError();
      if (fallbackUrl && finitePlaylist(s, probe)) {
        probe = await continuousInstead(s, probe, fallbackUrl, deadline.expired);
        if (s.state !== 'starting') throw stoppedError();
      }
      const plan = choosePlan(probe, { kind: s.kind, transcodeInterlaced: deps.transcodeInterlaced });
      s.inputFormat = probe.formatName;
      s.durationSec = s.kind === 'live' ? null : (s.durationHintSec ?? probe.durationSec);
      if (plan.mode === 'direct') {
        s.mode = 'direct';
        await letGoOfRelay(s); // the direct proxy holds the provider connection from here on
      } else {
        // HLS that only its content gave away: FFmpeg reads it from the provider, like any HLS input.
        if (s.inputFormat.includes('hls')) await letGoOfRelay(s);
        if (s.state !== 'starting') throw stoppedError();
        s.plan = plan;
        s.outDir = join(deps.transcodeDir, s.id);
        mkdirSync(s.outDir, { recursive: true });
        launch(s, 0); // through the relay, if still registered, for the whole session
        await waitUntilReady(s, deadline.expired);
      }
      if (s.state !== 'starting') throw stoppedError();
    } catch (err) {
      const shutDown = s.state !== 'starting'; // stopped from outside (shutdown), not a failure of the stream
      await stopSession(s, 'failed to start');
      let failure: PlaybackError;
      if (err instanceof PlaybackError) {
        failure = err;
      } else {
        log.warn({ sessionId: s.id, err: errorText(err) }, 'ffmpeg could not be started');
        failure = new PlaybackError('UPSTREAM_ERROR', 'The stream could not be started');
      }
      if (!shutDown && (failure.code === 'UPSTREAM_ERROR' || failure.code === 'STREAM_START_TIMEOUT')) {
        forgetCachedProbes(s);
      }
      throw failure;
    } finally {
      deadline.clear();
    }

    const now = deps.now();
    s.state = 'running';
    s.advancedAt = now;
    for (const clientId of s.clients.keys()) s.clients.set(clientId, now);
    sessions.set(s.id, s);
    const { id: sessionId, providerId, kind, mode } = s;
    const plan = s.plan && {
      segment: s.plan.segment,
      video: s.plan.video,
      audio: s.plan.audio?.action ?? 'none',
      deinterlace: s.plan.deinterlace,
    };
    log.info({ sessionId, providerId, kind, mode, plan, url: redactUrl(s.sourceUrl) }, 'session started');
    // The child may have exited (having written a playlist) while we confirmed readiness.
    if (s.exit && s.child === null) {
      void s.exit.then((code) => {
        if (s.state === 'running') onRunningExit(s, code);
      });
    }
  }

  /** Step 1: leave every other session; any left without viewers is stopped and its FFmpeg awaited. */
  async function preempt(clientId: string, keepKey: string | null): Promise<void> {
    const stopping: Promise<void>[] = [];
    for (const s of sessions.values()) {
      if (s.key === keepKey || !s.clients.delete(clientId)) continue;
      if (s.clients.size === 0) stopping.push(stopSession(s, 'preempted'));
    }
    await Promise.all(stopping);
  }

  async function startNow(req: StartRequest): Promise<StartedSession> {
    const live = req.kind === 'live';
    const startAtSec = live || req.kind === 'catchup' ? 0 : req.startAtSec;
    const key = live
      ? `${req.providerId}|${req.contentKey}|${req.quality}`
      : `${req.clientId}|${req.contentKey}|${startAtSec}`;
    await preempt(req.clientId, live ? key : null);

    // Steps 2 and 3. Every await here re-checks from the top; the final pass through and the
    // registration below run without yielding, so no two starts can both claim the last connection.
    for (;;) {
      if (closed) throw new PlaybackError('UPSTREAM_ERROR', 'Playback is shutting down');
      if (live) {
        const existing = [...sessions.values()].find((s) => s.kind === 'live' && s.key === key);
        if (existing) {
          existing.clients.set(req.clientId, deps.now());
          return toResponse(existing, req.clientId);
        }
        const inFlight = starting.get(key);
        if (inFlight) {
          await inFlight.done; // a failed start rejects every joiner with the same error
          continue;
        }
      }
      const limit = connectionLimit(req.providerId);
      const holders = upstreamHolders(req.providerId);
      if (limit === null || holders.length < limit) break;
      const leaving = [...dying].filter(([s]) => s.providerId === req.providerId).map(([, done]) => done);
      if (leaving.length === 0) {
        const watchingClientIds = [...new Set(holders.flatMap((s) => [...s.clients.keys()]))];
        const message = `The provider allows ${limit} connection(s)`;
        throw new PlaybackError('PROVIDER_CONNECTION_LIMIT', message, { limit, watchingClientIds });
      }
      await Promise.all(leaving); // a closing session holds its connection until FFmpeg (or ffprobe) ends
    }

    // Steps 4 and 5.
    const s: Session = {
      id: randomUUID(),
      key,
      providerId: req.providerId,
      kind: req.kind,
      sourceUrl: req.sourceUrl,
      userAgent: req.userAgent,
      startAtSec,
      state: 'starting',
      mode: 'hls',
      durationHintSec: req.durationHintSec ?? null,
      durationSec: null,
      plan: null,
      inputFormat: '',
      outDir: null,
      child: null,
      exit: null,
      relayed: null,
      probing: null,
      cachedProbes: [],
      restarts: 0,
      restartTimer: null,
      launchSegment: -1,
      launchedAt: 0,
      stalled: false,
      lastSegment: -1,
      advancedAt: 0,
      healthySince: null,
      prunes: [],
      clients: new Map([[req.clientId, deps.now()]]),
      stopped: null,
    };
    const done = open(s, req.fallbackSourceUrl);
    starting.set(key, { session: s, done });
    try {
      await done;
    } finally {
      starting.delete(key);
    }
    return toResponse(s, req.clientId);
  }

  /** Drops viewers who stopped fetching; a session whose last viewer is dropped is stopped. */
  async function reap(): Promise<void> {
    const now = deps.now();
    const stops: Promise<void>[] = [];
    for (const s of sessions.values()) {
      const idleMs = s.kind === 'live' ? deps.liveIdleMs : deps.vodIdleMs;
      for (const [clientId, seen] of s.clients) {
        if (now - seen < idleMs) continue;
        s.clients.delete(clientId);
        log.info({ sessionId: s.id, clientId }, 'viewer timed out');
      }
      if (s.clients.size === 0) stops.push(stopSession(s, 'idle'));
    }
    await Promise.all(stops);
  }

  return {
    start(req) {
      if (!CLIENT_ID.test(req.clientId)) {
        return Promise.reject(new Error('clientId must be 1-64 characters of A-Z, a-z, 0-9, "_" or "-"'));
      }
      // One start at a time per client: a rapid second request waits, then preempts the first.
      const previous = clientQueues.get(req.clientId) ?? Promise.resolve();
      const result = previous.then(() => startNow(req));
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      clientQueues.set(req.clientId, tail);
      void tail.then(() => {
        if (clientQueues.get(req.clientId) === tail) clientQueues.delete(req.clientId);
      });
      return result;
    },

    touch(sessionId, clientId) {
      const s = sessions.get(sessionId); // running sessions only: a stopping one is never revived
      if (!s || !CLIENT_ID.test(clientId)) return false;
      s.clients.set(clientId, deps.now());
      return true;
    },

    async release(sessionId, clientId) {
      const s = sessions.get(sessionId);
      if (!s || !s.clients.delete(clientId)) return;
      if (s.clients.size === 0) await stopSession(s, 'released');
    },

    resolveFile(sessionId, file) {
      const s = sessions.get(sessionId);
      if (!s?.outDir || !PLAIN_FILE.test(file)) return null;
      return join(s.outDir, file);
    },

    directSource(sessionId) {
      const s = sessions.get(sessionId);
      return s?.mode === 'direct' ? { url: s.sourceUrl, userAgent: s.userAgent } : null;
    },

    activeUpstreams(providerId) {
      return upstreamHolders(providerId).length;
    },

    reap,

    async stopAll() {
      closed = true;
      clearInterval(housekeeping);
      const all = [...sessions.values(), ...startingSessions(), ...dying.keys()];
      await Promise.all(all.map((s) => stopSession(s, 'shutdown')));
      removeSessionDirs();
    },
  };
}
