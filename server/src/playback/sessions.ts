import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PlayResponse } from '@tv/shared';
import { redactUrl } from '../util/redact.ts';
import { buildFfmpegArgs } from './ffmpegArgs.ts';
import { choosePlan } from './policy.ts';
import type { HlsPlan } from './policy.ts';
import type { ProbeResult, Prober } from './probe.ts';

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
};

export type StartRequest = {
  providerId: number;
  kind: 'live' | 'movie' | 'episode';
  contentKey: string;
  sourceUrl: string;
  /** Live only: the provider's continuous stream, used instead if `sourceUrl` is a finite playlist (R29). */
  fallbackSourceUrl?: string;
  userAgent: string;
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
// A plain file name: no separators, no drive or stream colons, not '.' or '..'.
const PLAIN_FILE = /^[\w-][\w.-]*$/;
// Session dirs are named by randomUUID(); nothing else in transcodeDir is ever removed.
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  durationSec: number | null;
  plan: HlsPlan | null;
  inputFormat: string; // ffprobe's format_name for the source
  outDir: string | null;
  child: ChildLike | null;
  exit: Promise<number | null> | null; // resolves when the current child exits
  probing: Promise<void> | null; // an ffprobe that is still connected
  restarts: number; // consecutive failures
  restartTimer: ReturnType<typeof setTimeout> | null;
  launchSegment: number; // highest segment before the current process started (its start number - 1)
  launchedAt: number; // when the current process started
  stalled: boolean; // the watchdog killed the current process
  lastSegment: number; // live watchdog: highest segment seen,
  advancedAt: number; // when it last went up,
  healthySince: number | null; // and when the current process first produced one
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
    const stopped = (async () => {
      await killAndWait(s);
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
      url: s.sourceUrl,
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

  async function probeWithin(s: Session, url: string, expired: Promise<never>): Promise<ProbeResult> {
    const probing = deps.probe(url, s.userAgent);
    const done = () => {
      if (s.probing === ended) s.probing = null;
    };
    const ended = probing.then(done, done);
    s.probing = ended;
    try {
      return await Promise.race([probing, expired]);
    } catch (err) {
      if (err instanceof PlaybackError) throw err; // the deadline
      log.warn({ url: redactUrl(url), err: errorText(err) }, 'probe failed');
      throw new PlaybackError('UPSTREAM_ERROR', 'The stream could not be opened');
    }
  }

  /** R29: a live HLS input with a duration is an ENDLIST playlist, which FFmpeg reads to the end and leaves. */
  const finitePlaylist = (s: Session, probe: ProbeResult) =>
    s.kind === 'live' && probe.formatName.includes('hls') && probe.durationSec !== null;

  /** Switches the session to the provider's continuous stream, unless that can't be probed (within the same deadline). */
  async function continuousInstead(s: Session, playlist: ProbeResult, url: string, expired: Promise<never>): Promise<ProbeResult> {
    const { durationSec } = playlist;
    const urls = { url: redactUrl(s.sourceUrl), fallback: redactUrl(url) };
    log.info({ sessionId: s.id, ...urls, durationSec }, 'live playlist is finite; switching to continuous stream');
    try {
      const probe = await probeWithin(s, url, expired);
      // Only an actual stream will do. Some servers answer every live extension with the same playlist,
      // and HLS behind a non-.m3u8 URL would also be read without -http_multiple 0.
      if (probe.formatName.includes('hls')) {
        log.info({ sessionId: s.id, ...urls }, 'continuous stream is a playlist too; playing the original');
        return playlist;
      }
      s.sourceUrl = url;
      return probe;
    } catch (err) {
      if (err instanceof PlaybackError && err.code === 'STREAM_START_TIMEOUT') throw err;
      log.warn({ sessionId: s.id, url: urls.url }, 'continuous stream could not be opened; playing the playlist');
      return playlist;
    }
  }

  async function open(s: Session, fallbackUrl: string | undefined): Promise<void> {
    const deadline = startDeadline(deps.readyTimeoutMs); // probes + spawn + ready, all together
    try {
      let probe = await probeWithin(s, s.sourceUrl, deadline.expired);
      if (s.state !== 'starting') throw stoppedError();
      if (fallbackUrl && finitePlaylist(s, probe)) {
        probe = await continuousInstead(s, probe, fallbackUrl, deadline.expired);
        if (s.state !== 'starting') throw stoppedError();
      }
      const plan = choosePlan(probe, { kind: s.kind, transcodeInterlaced: deps.transcodeInterlaced });
      s.inputFormat = probe.formatName;
      s.durationSec = s.kind === 'live' ? null : probe.durationSec;
      if (plan.mode === 'direct') {
        s.mode = 'direct';
      } else {
        s.plan = plan;
        s.outDir = join(deps.transcodeDir, s.id);
        mkdirSync(s.outDir, { recursive: true });
        launch(s, 0);
        await waitUntilReady(s, deadline.expired);
      }
      if (s.state !== 'starting') throw stoppedError();
    } catch (err) {
      await stopSession(s, 'failed to start');
      if (err instanceof PlaybackError) throw err;
      log.warn({ sessionId: s.id, err: errorText(err) }, 'ffmpeg could not be started');
      throw new PlaybackError('UPSTREAM_ERROR', 'The stream could not be started');
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
    const key = live
      ? `${req.providerId}|${req.contentKey}|${req.quality}`
      : `${req.clientId}|${req.contentKey}|${req.startAtSec}`;
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
      startAtSec: live ? 0 : req.startAtSec,
      state: 'starting',
      mode: 'hls',
      durationSec: null,
      plan: null,
      inputFormat: '',
      outDir: null,
      child: null,
      exit: null,
      probing: null,
      restarts: 0,
      restartTimer: null,
      launchSegment: -1,
      launchedAt: 0,
      stalled: false,
      lastSegment: -1,
      advancedAt: 0,
      healthySince: null,
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
