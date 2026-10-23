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
  liveIdleMs: number /* 20_000 */;
  vodIdleMs: number /* 60_000 */;
  readyTimeoutMs: number /* 15_000 */;
  maxRestarts: number /* 3 */;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
};

export type StartRequest = {
  providerId: number;
  kind: 'live' | 'movie' | 'episode';
  contentKey: string;
  sourceUrl: string;
  userAgent: string;
  startAtSec: number;
  clientId: string;
  quality: 'original';
};

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
  start(req: StartRequest): Promise<StartedSession>;
  touch(sessionId: string): boolean;
  release(sessionId: string, clientId: string): Promise<void>;
  resolveFile(sessionId: string, file: string): string | null;
  directSource(sessionId: string): { url: string; userAgent: string } | null;
  activeUpstreams(providerId: number): number;
  reap(): Promise<void>;
  stopAll(): Promise<void>;
}

const READY_POLL_MS = 200;
const REAP_INTERVAL_MS = 5_000;
// FFmpeg hard-exits after more than three termination signals, so re-signalling a stuck one ends it.
const KILL_RETRY_MS = 2_000;
// A plain file name: no separators, no drive or stream colons, not '.' or '..'.
const PLAIN_FILE = /^[\w-][\w.-]*$/;

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
  sourceUrl: string;
  userAgent: string;
  startAtSec: number;
  // starting: probing/spawning, not yet joinable; running: registered; stopping: on its way out.
  state: 'starting' | 'running' | 'stopping';
  mode: 'hls' | 'direct';
  durationSec: number | null;
  plan: HlsPlan | null;
  outDir: string | null;
  child: ChildLike | null;
  exit: Promise<number | null> | null; // resolves when the current child exits
  restarts: number;
  clients: Set<string>;
  lastSeen: number;
  stopped: Promise<void> | null;
};

const errorText = (err: unknown) => redactUrl(err instanceof Error ? err.message : String(err));

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { log } = deps;
  const sessions = new Map<string, Session>(); // running sessions, by id
  const starting = new Map<string, { session: Session; done: Promise<void> }>(); // in-flight starts, by key
  const dying = new Map<Session, Promise<void>>(); // stopping, until FFmpeg has exited and files are gone
  const clientQueues = new Map<string, Promise<void>>();
  let closed = false;

  emptyDir(deps.transcodeDir);
  const reapTimer = setInterval(() => void reap(), REAP_INTERVAL_MS);
  reapTimer.unref();

  function emptyDir(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
      for (const name of readdirSync(dir)) {
        rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    } catch (err) {
      log.warn({ dir, err: errorText(err) }, 'could not empty transcode dir');
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

  /** Sessions that hold (or are about to open) a provider connection. */
  function upstreamHolders(providerId: number): Session[] {
    const all = new Set<Session>([...sessions.values(), ...startingSessions(), ...dying.keys()]);
    return [...all].filter(
      (s) => s.providerId === providerId && (s.state === 'starting' || s.mode === 'direct' || s.child !== null),
    );
  }

  function connectionLimit(providerId: number): number | null {
    const limit = deps.maxConnections(providerId);
    return limit !== null && limit > 0 ? limit : null; // a reported 0 is treated as "no limit"
  }

  function toResponse(s: Session): StartedSession {
    const file = s.mode === 'hls' ? 'index.m3u8' : 'direct';
    const { id: sessionId, mode, durationSec, startAtSec } = s;
    return { sessionId, mode, url: `/api/sessions/${sessionId}/${file}`, durationSec, startAtSec };
  }

  function stopSession(s: Session, reason: string): Promise<void> {
    if (s.stopped) return s.stopped;
    s.state = 'stopping';
    sessions.delete(s.id);
    s.clients.clear();
    s.stopped = (async () => {
      await killAndWait(s);
      if (s.outDir) await removeDir(s.outDir);
      dying.delete(s);
      log.info({ sessionId: s.id, reason }, 'session stopped');
    })();
    dying.set(s, s.stopped);
    return s.stopped;
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
    if (s.restarts >= deps.maxRestarts) {
      log.warn({ sessionId: s.id, code, restarts: s.restarts }, 'ffmpeg keeps exiting; giving up');
      void stopSession(s, 'upstream failed');
      return;
    }
    s.restarts++;
    const startNumber = lastSegment(s.outDir!) + 1;
    log.warn({ sessionId: s.id, code, restart: s.restarts, startNumber }, 'ffmpeg exited; restarting');
    try {
      launch(s, startNumber);
    } catch (err) {
      log.warn({ sessionId: s.id, err: errorText(err) }, 'ffmpeg restart failed');
      void stopSession(s, 'upstream failed');
    }
  }

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

  function waitUntilReady(s: Session): Promise<void> {
    const outDir = s.outDir!;
    const ready = () => deps.isReady(outDir).catch(() => false);
    return new Promise((resolve, reject) => {
      let settled = false;
      let poll: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = deps.readyTimeoutMs;
      const deadline = setTimeout(
        () => settle(new PlaybackError('STREAM_START_TIMEOUT', `The stream did not start within ${timeoutMs} ms`)),
        timeoutMs,
      );
      function settle(err: PlaybackError | null): void {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
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
      // A short VOD remux can finish between polls, so look once more before calling it a failure.
      void s.exit!.then(async () => {
        if (settled) return;
        const ok = await ready();
        settle(ok ? null : new PlaybackError('UPSTREAM_ERROR', 'FFmpeg exited before the stream was ready'));
      });
      void check();
    });
  }

  async function open(s: Session): Promise<void> {
    let probe: ProbeResult;
    try {
      probe = await deps.probe(s.sourceUrl, s.userAgent);
    } catch (err) {
      log.warn({ url: redactUrl(s.sourceUrl), err: errorText(err) }, 'probe failed');
      throw new PlaybackError('UPSTREAM_ERROR', 'The stream could not be opened');
    }
    if (s.state !== 'starting') throw new PlaybackError('UPSTREAM_ERROR', 'Playback was stopped');

    const plan = choosePlan(probe, { kind: s.kind, transcodeInterlaced: deps.transcodeInterlaced });
    s.durationSec = s.kind === 'live' ? null : probe.durationSec;
    if (plan.mode === 'direct') {
      s.mode = 'direct';
    } else {
      s.plan = plan;
      s.outDir = join(deps.transcodeDir, s.id);
      try {
        mkdirSync(s.outDir, { recursive: true });
        launch(s, 0);
        await waitUntilReady(s);
      } catch (err) {
        await stopSession(s, 'failed to start');
        if (err instanceof PlaybackError) throw err;
        log.warn({ sessionId: s.id, err: errorText(err) }, 'ffmpeg could not be started');
        throw new PlaybackError('UPSTREAM_ERROR', 'The stream could not be started');
      }
      if (s.state !== 'starting') throw new PlaybackError('UPSTREAM_ERROR', 'Playback was stopped');
    }

    s.state = 'running';
    s.lastSeen = deps.now();
    sessions.set(s.id, s);
    const { id: sessionId, providerId, kind, mode } = s;
    log.info({ sessionId, providerId, kind, mode, url: redactUrl(s.sourceUrl) }, 'session started');
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
          existing.clients.add(req.clientId);
          existing.lastSeen = deps.now();
          return toResponse(existing);
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
        const watchingClientIds = [...new Set(holders.flatMap((s) => [...s.clients]))];
        const message = `The provider allows ${limit} connection(s)`;
        throw new PlaybackError('PROVIDER_CONNECTION_LIMIT', message, { limit, watchingClientIds });
      }
      await Promise.all(leaving); // a closing session still holds its connection until FFmpeg exits
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
      outDir: null,
      child: null,
      exit: null,
      restarts: 0,
      clients: new Set([req.clientId]),
      lastSeen: deps.now(),
      stopped: null,
    };
    const done = open(s);
    starting.set(key, { session: s, done });
    try {
      await done;
    } finally {
      starting.delete(key);
    }
    return toResponse(s);
  }

  async function reap(): Promise<void> {
    const now = deps.now();
    const idle = [...sessions.values()].filter(
      (s) => now - s.lastSeen >= (s.kind === 'live' ? deps.liveIdleMs : deps.vodIdleMs),
    );
    await Promise.all(idle.map((s) => stopSession(s, 'idle')));
  }

  return {
    start(req) {
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

    touch(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return false;
      s.lastSeen = deps.now();
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
      clearInterval(reapTimer);
      const all = [...sessions.values(), ...startingSessions(), ...dying.keys()];
      await Promise.all(all.map((s) => stopSession(s, 'shutdown')));
      emptyDir(deps.transcodeDir);
    },
  };
}
