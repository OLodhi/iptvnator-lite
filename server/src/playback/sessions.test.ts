import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildFfmpegArgs } from './ffmpegArgs.ts';
import type { HlsPlan } from './policy.ts';
import type { ProbeResult } from './probe.ts';
import { createSessionManager, defaultIsReady, PlaybackError, pruneSegments } from './sessions.ts';
import type { ChildLike, SessionManager, SessionManagerDeps, StartRequest } from './sessions.ts';

const H264 = { codec: 'h264', codecTag: null, width: 1280, height: 720, interlaced: false, fieldOrder: 'progressive' };
const AAC = [{ index: 1, codec: 'aac', channels: 2 }];
const LIVE_HLS: ProbeResult = { formatName: 'hls', durationSec: null, video: H264, audio: AAC };
const FINITE_HLS: ProbeResult = { ...LIVE_HLS, durationSec: 15 }; // an ENDLIST playlist
const LIVE_TS: ProbeResult = { formatName: 'mpegts', durationSec: null, video: H264, audio: AAC };
const MKV_MOVIE: ProbeResult = { formatName: 'matroska,webm', durationSec: 60, video: H264, audio: AAC };
const MP4_MOVIE: ProbeResult = {
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec: 60,
  video: { ...H264, codecTag: 'avc1' },
  audio: AAC,
};

const UA = 'TiviMate/4.7.0';
const live = (n: number, clientId: string): StartRequest => ({
  providerId: 1,
  kind: 'live',
  contentKey: `live:${n}`,
  sourceUrl: `http://provider.test/live/user/secret/${n}.m3u8`,
  userAgent: UA,
  startAtSec: 0,
  clientId,
  quality: 'original',
});
const liveWithFallback = (n: number, clientId: string) => ({
  ...live(n, clientId),
  fallbackSourceUrl: `http://provider.test/live/user/secret/${n}.ts`,
});
const movie = (n: number, clientId: string, ext = 'mkv'): StartRequest => ({
  providerId: 1,
  kind: 'movie',
  contentKey: `movie:${n}`,
  sourceUrl: `http://provider.test/movie/user/secret/${n}.${ext}`,
  userAgent: UA,
  startAtSec: 0,
  clientId,
  quality: 'original',
});
const SESSION_DIR_NAME = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HOUR = 3_600_000;

/** A controllable stand-in for an FFmpeg child: kill() makes it exit 50 ms later (unless told to ignore kills). */
class FakeChild extends EventEmitter implements ChildLike {
  n: number;
  pid: number;
  args: string[];
  stderr = new PassThrough();
  kills = 0;
  ignoreKills = 0;
  exited = false;
  private events: string[];

  constructor(n: number, args: string[], events: string[]) {
    super();
    this.n = n;
    this.pid = 1000 + n;
    this.args = args;
    this.events = events;
  }

  kill(): boolean {
    this.kills++;
    this.events.push(`kill:${this.n}`);
    if (this.kills > this.ignoreKills) setTimeout(() => this.exit(null), 50);
    return true;
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.events.push(`exit:${this.n}`);
    this.stderr.end();
    this.emit('exit', code);
  }
}

let transcodeDir: string;
let managers: SessionManager[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  transcodeDir = mkdtempSync(join(tmpdir(), 'tv-sessions-test-'));
});

afterEach(async () => {
  const stops = managers.splice(0).map((m) => m.stopAll());
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all(stops);
  vi.useRealTimers();
  rmSync(transcodeDir, { recursive: true, force: true });
});

/** Lets pending promise callbacks run (one real macrotask turn) without moving the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);
const delayed = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function harness(overrides: Partial<SessionManagerDeps> = {}) {
  const events: string[] = [];
  const children: FakeChild[] = [];
  const logs: { level: 'info' | 'warn'; o: object; m: string }[] = [];
  let ready: (outDir: string) => boolean = () => true;
  const readyDirs = new Set<string>();

  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child = new FakeChild(children.length + 1, args, events);
    children.push(child);
    events.push(`spawn:${child.n}`);
    return child;
  });
  const probe = vi.fn(async (url: string, _userAgent: string) =>
    url.endsWith('.mp4') ? MP4_MOVIE : url.endsWith('.mkv') ? MKV_MOVIE : LIVE_HLS,
  );
  const deps: SessionManagerDeps = {
    ffmpegPath: 'ffmpeg',
    transcodeDir,
    spawn,
    probe,
    transcodeInterlaced: false,
    maxConnections: () => null,
    isReady: async (outDir) => {
      readyDirs.add(outDir);
      return ready(outDir);
    },
    now: () => Date.now(),
    liveIdleMs: 20_000,
    vodIdleMs: 60_000,
    readyTimeoutMs: 15_000,
    maxRestarts: 3,
    stallTimeoutMs: 20_000,
    log: {
      info: (o, m) => logs.push({ level: 'info', o, m }),
      warn: (o, m) => logs.push({ level: 'warn', o, m }),
    },
    ...overrides,
  };
  const m = createSessionManager(deps);
  managers.push(m);
  return {
    m,
    events,
    children,
    spawn,
    probe,
    logs,
    readyDirs,
    setReady(fn: (outDir: string) => boolean) {
      ready = fn;
    },
  };
}

const outDirOf = (m: SessionManager, sessionId: string) => dirname(m.resolveFile(sessionId, 'index.m3u8')!);
/** Side-effect-free liveness check (touch() would re-add a viewer). */
const alive = (m: SessionManager, sessionId: string) =>
  m.resolveFile(sessionId, 'index.m3u8') !== null || m.directSource(sessionId) !== null;
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
/** The backoff of every failure-restart so far (reconnects are not failures and log differently). */
const restartDelays = (logs: { m: string; o: object }[]) =>
  logs.filter((l) => l.m === 'ffmpeg exited; restarting').map((l) => (l.o as { delayMs: number }).delayMs);
// R29 log lines, and the redacted forms of liveWithFallback(1)'s URLs.
const TRYING = 'trying the continuous stream';
const SWITCHED = 'switched to continuous stream';
const NOT_USED = 'continuous stream not used; playing the playlist';
const REDACTED_M3U8 = 'http://provider.test/live/***/***/1.m3u8';
const REDACTED_TS = 'http://provider.test/live/***/***/1.ts';
const fallbackLogs = <L extends { m: string }>(logs: L[]) => logs.filter((l) => [TRYING, SWITCHED, NOT_USED].includes(l.m));

function writePlaylist(outDir: string, first: number, last: number): void {
  let text = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n';
  for (let i = first; i <= last; i++) text += `#EXTINF:3.000000,\nseg_${String(i).padStart(5, '0')}.ts\n`;
  writeFileSync(join(outDir, 'index.m3u8'), text);
}

/** Writes the segment files themselves (writePlaylist only lists them). */
function writeSegments(outDir: string, first: number, last: number, ext = 'ts'): void {
  for (let i = first; i <= last; i++) writeFileSync(join(outDir, `seg_${String(i).padStart(5, '0')}.${ext}`), 'x');
}
const SEGMENT_FILE = /^seg_(\d+)\.(ts|m4s)$/;
const segmentFiles = (dir: string) => readdirSync(dir).filter((f) => SEGMENT_FILE.test(f)).sort();
const segmentNames = (first: number, last: number, ext = 'ts') =>
  Array.from({ length: last - first + 1 }, (_, i) => `seg_${String(first + i).padStart(5, '0')}.${ext}`);

describe('session manager', () => {
  test('shares a live session between two clients', async () => {
    const h = harness();
    const a = await h.m.start(live(1, 'A'));
    const b = await h.m.start(live(1, 'B'));

    expect(b.sessionId).toBe(a.sessionId);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(a).toEqual({
      sessionId: a.sessionId,
      mode: 'hls',
      url: `/api/sessions/${a.sessionId}/A/index.m3u8`,
      durationSec: null,
      startAtSec: 0,
    });
    expect(b.url).toBe(`/api/sessions/${a.sessionId}/B/index.m3u8`);
    expect(h.spawn.mock.calls[0]![0]).toBe('ffmpeg');
    expect(h.m.activeUpstreams(1)).toBe(1);
  });

  test("preempts the client's previous session before spawning the next", async () => {
    const h = harness();
    const first = await h.m.start(live(1, 'A'));
    const next = h.m.start(live(2, 'A'));
    await vi.advanceTimersByTimeAsync(100);
    const second = await next;

    expect(h.events).toEqual(['spawn:1', 'kill:1', 'exit:1', 'spawn:2']);
    expect(alive(h.m, first.sessionId)).toBe(false);
    expect(alive(h.m, second.sessionId)).toBe(true);
    expect(existsSync(join(transcodeDir, first.sessionId))).toBe(false);
  });

  test('keeps a shared session alive for its other viewers', async () => {
    const h = harness();
    const s1 = await h.m.start(live(1, 'A'));
    await h.m.start(live(1, 'B'));
    await h.m.start(live(2, 'A'));

    expect(h.children[0]!.kills).toBe(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(alive(h.m, s1.sessionId)).toBe(true);

    // When the last viewer leaves, it goes.
    const released = h.m.release(s1.sessionId, 'B');
    await vi.advanceTimersByTimeAsync(100);
    await released;
    expect(h.children[0]!.exited).toBe(true);
    expect(alive(h.m, s1.sessionId)).toBe(false);
  });

  test('rejects with PROVIDER_CONNECTION_LIMIT naming who is watching', async () => {
    const h = harness({ maxConnections: () => 1 });
    await h.m.start(live(1, 'B'));
    const attempt = h.m.start(live(2, 'A'));

    await expect(attempt).rejects.toBeInstanceOf(PlaybackError);
    await expect(attempt).rejects.toMatchObject({
      code: 'PROVIDER_CONNECTION_LIMIT',
      details: { limit: 1, watchingClientIds: ['B'] },
    });
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  test('times out a stream that never becomes ready and cleans up', async () => {
    const h = harness();
    h.setReady(() => false);
    const outcome = expect(h.m.start(live(1, 'A'))).rejects.toMatchObject({ code: 'STREAM_START_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(14_900);
    expect(h.children[0]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    await outcome;

    expect(h.children[0]!.exited).toBe(true);
    const [outDir] = [...h.readyDirs];
    expect(outDir).toBeDefined();
    expect(existsSync(outDir!)).toBe(false);
    expect(readdirSync(transcodeDir)).toEqual([]);
    expect(h.m.activeUpstreams(1)).toBe(0);
  });

  test('reaps idle sessions: live after 20 s, vod after 60 s', async () => {
    const h = harness();
    const l = await h.m.start(live(1, 'A'));
    const v = await h.m.start(movie(1, 'B'));
    expect(v.mode).toBe('hls');
    const liveDir = outDirOf(h.m, l.sessionId);
    const vodDir = outDirOf(h.m, v.sessionId);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.children[0]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); // 20 s idle
    expect(h.children[0]!.kills).toBe(1);
    expect(alive(h.m, l.sessionId)).toBe(false);

    await vi.advanceTimersByTimeAsync(35_000); // 55 s
    expect(h.children[1]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); // 60 s idle
    expect(h.children[1]!.kills).toBe(1);
    expect(alive(h.m, v.sessionId)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => {
      expect(existsSync(liveDir)).toBe(false);
      expect(existsSync(vodDir)).toBe(false);
    });

    // touch() resets the idle clock.
    const t = harness({ stallTimeoutMs: HOUR });
    const s = await t.m.start(live(2, 'C'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.m.touch(s.sessionId, 'C')).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.children[0]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); // 20 s since the touch
    expect(t.children[0]!.kills).toBe(1);
    expect(t.m.touch(s.sessionId, 'C')).toBe(false);
  });

  test('restarts a live process that dies before producing 2 segments, continuing segment numbers, at most 3 times', async () => {
    const h = harness();
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    expect(h.children[0]!.args).not.toContain('-start_number');

    // Each run below is quick (under 10 s) and produces one new segment: a failure on both counts (R28a).
    // The segment count alone is pinned by 'a long run that wrote only one new segment is a failure'.
    writePlaylist(outDir, 0, 0);
    h.children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawn).toHaveBeenCalledTimes(1); // backing off
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(argAfter(h.children[1]!.args, '-start_number')).toBe('1');
    expect(argAfter(h.children[1]!.args, '-hls_flags')).toContain('discont_start');

    writePlaylist(outDir, 0, 1);
    h.children[1]!.exit(0); // a clean exit is no different
    await vi.advanceTimersByTimeAsync(2_000);
    expect(argAfter(h.children[2]!.args, '-start_number')).toBe('2');

    writePlaylist(outDir, 0, 2);
    h.children[2]!.exit(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(argAfter(h.children[3]!.args, '-start_number')).toBe('3');
    expect(alive(h.m, s.sessionId)).toBe(true);

    writePlaylist(outDir, 0, 3);
    h.children[3]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawn).toHaveBeenCalledTimes(4);
    expect(alive(h.m, s.sessionId)).toBe(false);
    expect(h.m.activeUpstreams(1)).toBe(0);
    await vi.waitFor(() => expect(existsSync(outDir)).toBe(false));
  });

  test('direct-mode sessions spawn no ffmpeg but count as an upstream', async () => {
    const h = harness();
    const req = movie(2, 'A', 'mp4');
    const s = await h.m.start(req);

    expect(s).toEqual({
      sessionId: s.sessionId,
      mode: 'direct',
      url: `/api/sessions/${s.sessionId}/A/direct`,
      durationSec: 60,
      startAtSec: 0,
    });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.m.activeUpstreams(1)).toBe(1);
    expect(h.m.activeUpstreams(2)).toBe(0);
    expect(h.m.directSource(s.sessionId)).toEqual({ url: req.sourceUrl, userAgent: UA });
    expect(h.m.resolveFile(s.sessionId, 'index.m3u8')).toBeNull();

    const hls = await h.m.start(live(1, 'B'));
    expect(h.m.directSource(hls.sessionId)).toBeNull();
    expect(h.m.directSource('nope')).toBeNull();
  });

  test('resolveFile rejects anything but a plain file name', async () => {
    const h = harness();
    const s = await h.m.start(live(1, 'A'));

    for (const bad of ['../x', 'a/b', 'a\\b', '', '.', '..', 'C:x', 'index.m3u8:stream', '/etc/passwd']) {
      expect(h.m.resolveFile(s.sessionId, bad), bad).toBeNull();
    }
    const file = h.m.resolveFile(s.sessionId, 'seg_00001.ts')!;
    expect(basename(file)).toBe('seg_00001.ts');
    expect(dirname(file)).toBe(join(transcodeDir, basename(dirname(file))));
    expect(h.readyDirs.has(dirname(file))).toBe(true);
    expect(h.m.resolveFile('unknown-session', 'seg_00001.ts')).toBeNull();
  });

  test('stopAll kills every child and removes the session dirs', async () => {
    const h = harness();
    await h.m.start(live(1, 'A'));
    await h.m.start(live(2, 'B'));
    await h.m.start(movie(1, 'C'));
    writeFileSync(join(transcodeDir, 'stray.txt'), 'not ours');

    const stopped = h.m.stopAll();
    await vi.advanceTimersByTimeAsync(100);
    await stopped;

    expect(h.children).toHaveLength(3);
    expect(h.children.every((c) => c.kills === 1 && c.exited)).toBe(true);
    expect(readdirSync(transcodeDir)).toEqual(['stray.txt']); // R17: only session dirs are removed
    expect(h.m.activeUpstreams(1)).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // housekeeping interval cleared
    await expect(h.m.start(live(1, 'A'))).rejects.toBeInstanceOf(PlaybackError);
    expect(h.spawn).toHaveBeenCalledTimes(3);
  });

  test('removes leftover session dirs on creation but nothing else', () => {
    mkdirSync(join(transcodeDir, SESSION_DIR_NAME));
    writeFileSync(join(transcodeDir, SESSION_DIR_NAME, 'seg_00001.ts'), 'x');
    mkdirSync(join(transcodeDir, 'keep-me'));
    writeFileSync(join(transcodeDir, 'stray.txt'), 'x');
    harness();
    expect(readdirSync(transcodeDir).sort()).toEqual(['keep-me', 'stray.txt']);
  });

  // Ruling R13: overlapping starts must never leave two upstreams open.
  test('serialises overlapping starts from one client', async () => {
    const h = harness();
    const p1 = h.m.start(live(1, 'A'));
    const p2 = h.m.start(live(2, 'A'));
    await vi.advanceTimersByTimeAsync(100);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(h.events).toEqual(['spawn:1', 'kill:1', 'exit:1', 'spawn:2']);
    expect(h.children.filter((c) => !c.exited)).toEqual([h.children[1]]);
    expect(alive(h.m, r1.sessionId)).toBe(false);
    expect(alive(h.m, r2.sessionId)).toBe(true);
    expect(h.m.activeUpstreams(1)).toBe(1);
  });

  test('concurrent starts of the same channel join one in-flight start', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.m.start(live(1, 'A')), h.m.start(live(1, 'B'))]);

    expect(a.sessionId).toBe(b.sessionId);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledTimes(1);

    // Both are viewers: one leaving keeps it alive for the other.
    await h.m.release(a.sessionId, 'A');
    expect(h.children[0]!.kills).toBe(0);
    expect(alive(h.m, a.sessionId)).toBe(true);
  });

  test('concurrent starts of the same channel share one failed start', async () => {
    const h = harness();
    h.setReady(() => false);
    const a = h.m.start(live(1, 'A')).catch((e: unknown) => e);
    const b = h.m.start(live(1, 'B')).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_100);
    const [ea, eb] = await Promise.all([a, b]);

    expect(ea).toBeInstanceOf(PlaybackError);
    expect((ea as PlaybackError).code).toBe('STREAM_START_TIMEOUT');
    expect(eb).toBe(ea);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  test('counts a start still in progress against the connection limit', async () => {
    const h = harness({ maxConnections: () => 1 });
    const a = h.m.start(live(1, 'A'));
    const b = h.m.start(live(2, 'B'));

    await expect(b).rejects.toMatchObject({
      code: 'PROVIDER_CONNECTION_LIMIT',
      details: { limit: 1, watchingClientIds: ['A'] },
    });
    await a;
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  test("waits for another client's closing session to exit before taking the connection", async () => {
    const h = harness({ maxConnections: () => 1 });
    const b = await h.m.start(live(1, 'B'));
    const released = h.m.release(b.sessionId, 'B');
    const a = h.m.start(live(2, 'A'));
    await vi.advanceTimersByTimeAsync(100);
    await released;

    await expect(a).resolves.toMatchObject({ mode: 'hls' });
    expect(h.events).toEqual(['spawn:1', 'kill:1', 'exit:1', 'spawn:2']);
  });

  test('treats a reported limit of 0 as no limit', async () => {
    const h = harness({ maxConnections: () => 0 });
    await h.m.start(live(1, 'A'));
    await h.m.start(live(2, 'B'));
    expect(h.m.activeUpstreams(1)).toBe(2);
  });

  test('a probe failure is an UPSTREAM_ERROR and spawns nothing', async () => {
    const h = harness({
      probe: async () => {
        throw new Error('ffprobe failed with exit code 1');
      },
    });
    await expect(h.m.start(live(999, 'A'))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.m.activeUpstreams(1)).toBe(0);
  });

  test('ffmpeg exiting before the stream is ready is an UPSTREAM_ERROR', async () => {
    const h = harness();
    h.setReady(() => false);
    const outcome = expect(h.m.start(live(1, 'A'))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    await flush();
    h.children[0]!.exit(1);
    await outcome;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.spawn).toHaveBeenCalledTimes(1); // no restart while starting
    expect(readdirSync(transcodeDir)).toEqual([]);
    expect(h.m.activeUpstreams(1)).toBe(0);
  });

  test('a vod remux that finishes before the next ready poll still starts', async () => {
    const h = harness();
    let finished = false;
    h.setReady(() => finished);
    const start = h.m.start(movie(1, 'A'));
    await flush();
    finished = true;
    h.children[0]!.exit(0);

    const s = await start;
    expect(s).toMatchObject({ mode: 'hls', durationSec: 60 });
    expect(alive(h.m, s.sessionId)).toBe(true);
    await flush();
    expect(h.logs.some((l) => l.m === 'ffmpeg finished')).toBe(true);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  test('logs ffmpeg stderr and urls with credentials redacted', async () => {
    const h = harness();
    await h.m.start(live(1, 'A'));
    h.children[0]!.stderr.write('[http @ 0x1] http://provider.test/live/user/secret/1.m3u8: 404 Not Found\n');
    await flush();

    const line = h.logs.find((l) => l.m === 'ffmpeg');
    expect(line?.o).toMatchObject({ line: expect.stringContaining('/live/***/***/1.m3u8') });
    expect(JSON.stringify(h.spawn.mock.calls)).toContain('secret'); // FFmpeg does get the real URL…
    expect(JSON.stringify(h.logs)).not.toContain('secret'); // …but no log line does.
  });

  test('the session started line names the chosen plan, without credentials', async () => {
    const h = harness({
      probe: async (url) =>
        url.endsWith('.mp4') ? MP4_MOVIE : { ...LIVE_HLS, formatName: 'mpegts', video: { ...H264, codec: 'mpeg2video' } },
    });
    const liveSession = await h.m.start(live(1, 'A'));
    const next = h.m.start(movie(2, 'A', 'mp4')); // preempts the live session, whose FFmpeg exits 50 ms after the kill
    await vi.advanceTimersByTimeAsync(100);
    const directSession = await next;

    const started = h.logs.filter((l) => l.m === 'session started');
    expect(started.map((l) => l.o)).toEqual([
      expect.objectContaining({
        sessionId: liveSession.sessionId,
        kind: 'live',
        mode: 'hls',
        plan: { segment: 'ts', video: 'h264', audio: 'copy', deinterlace: false },
      }),
      expect.objectContaining({ sessionId: directSession.sessionId, kind: 'movie', mode: 'direct', plan: null }),
    ]);
    expect(JSON.stringify(started)).not.toContain('secret');
  });

  test('signals an ffmpeg that ignores the first kill again until it exits', async () => {
    const h = harness();
    const s = await h.m.start(live(1, 'A'));
    h.children[0]!.ignoreKills = 2;
    const released = h.m.release(s.sessionId, 'A');
    await vi.advanceTimersByTimeAsync(5_000);
    await released;

    expect(h.children[0]!.kills).toBe(3);
    expect(h.children[0]!.exited).toBe(true);
  });

  // Ruling R14: one start deadline covers probe + spawn + ready.
  test('one 15 s deadline covers the probe as well as readiness', async () => {
    const h = harness({ probe: () => delayed(10_000, LIVE_HLS) });
    h.setReady(() => false);
    let settled = false;
    const start = h.m.start(live(1, 'A')).finally(() => {
      settled = true;
    });
    const outcome = expect(start).rejects.toMatchObject({ code: 'STREAM_START_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(10_100);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_800); // 14.9 s
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200); // 15.1 s: deadline, kill, exit
    await outcome; // settles without the clock moving any further

    expect(h.children[0]!.exited).toBe(true);
    expect(readdirSync(transcodeDir)).toEqual([]);
  });

  test('a probe still running at the deadline fails the start but keeps its connection counted', async () => {
    const slowLive1 = (url: string) => (url.endsWith('/1.m3u8') ? delayed(20_000, LIVE_HLS) : delayed(0, LIVE_HLS));
    const h = harness({ probe: slowLive1, maxConnections: () => 1 });
    const outcome = expect(h.m.start(live(1, 'A'))).rejects.toMatchObject({ code: 'STREAM_START_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.m.activeUpstreams(1)).toBe(1); // ffprobe is still connected

    // On a one-stream account the next start waits for that probe instead of opening a second connection.
    const next = h.m.start(live(2, 'B'));
    await vi.advanceTimersByTimeAsync(4_900); // 19.9 s
    expect(h.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200); // 20.1 s: the probe has finished
    await expect(next).resolves.toMatchObject({ mode: 'hls' });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.m.activeUpstreams(1)).toBe(1);
  });

  // Ruling R15: stall watchdog, consecutive-failure budget, backoff.
  test('restarts a live stream whose segments stop advancing for 20 s', async () => {
    const h = harness({ liveIdleMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    writePlaylist(outDir, 0, 4);
    await vi.advanceTimersByTimeAsync(5_000); // the watchdog sees segment 4
    await vi.advanceTimersByTimeAsync(19_000); // 19 s without a new segment
    expect(h.children[0]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000); // 20 s
    expect(h.children[0]!.kills).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100); // exit, then the 1 s backoff

    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(argAfter(h.children[1]!.args, '-start_number')).toBe('5');
    expect(argAfter(h.children[1]!.args, '-hls_flags')).toContain('discont_start');
    expect(alive(h.m, s.sessionId)).toBe(true);
    expect(h.logs.some((l) => l.level === 'warn' && l.m.includes('stalled'))).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  test('a restarted live stream that runs healthily for 60 s gets its restart budget back', async () => {
    const h = harness({ liveIdleMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    let seg = 0;
    const healthy = async (ms: number) => {
      for (let t = 0; t < ms; t += 5_000) {
        writePlaylist(outDir, Math.max(0, seg - 2), seg++);
        await vi.advanceTimersByTimeAsync(5_000);
      }
    };

    for (let stall = 1; stall <= 4; stall++) {
      await healthy(70_000);
      await vi.advanceTimersByTimeAsync(25_000); // no new segments: killed at 20 s, respawned after the backoff
      expect(h.spawn).toHaveBeenCalledTimes(stall + 1);
    }
    expect(alive(h.m, s.sessionId)).toBe(true);
    const delays = h.logs
      .filter((l) => l.m === 'ffmpeg exited; restarting')
      .map((l) => (l.o as { delayMs: number }).delayMs);
    expect(delays).toEqual([1_000, 1_000, 1_000, 1_000]);
  });

  test('backs off 1 s, 2 s, then 4 s between back-to-back restarts', async () => {
    const h = harness();
    const s = await h.m.start(live(1, 'A'));
    for (const [i, delay] of [1_000, 2_000, 4_000].entries()) {
      h.children[i]!.exit(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.spawn).toHaveBeenCalledTimes(i + 1);
      expect(h.m.activeUpstreams(1)).toBe(1); // it keeps its connection slot while waiting
      await vi.advanceTimersByTimeAsync(1);
      expect(h.spawn).toHaveBeenCalledTimes(i + 2);
    }
    h.children[3]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawn).toHaveBeenCalledTimes(4);
    expect(alive(h.m, s.sessionId)).toBe(false);
  });

  // Rulings R28/R28a: a live run that produced at least 2 new segments over at least 10 s and then exited is a reconnect.
  test('a live run that produced segments and exited cleanly reconnects at once, without using the restart budget', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);

    for (let run = 0; run < 5; run++) {
      writePlaylist(outDir, 0, 5 * run + 4); // five new segments, then the provider's playlist "ends"
      await vi.advanceTimersByTimeAsync(12_000);
      h.children[run]!.exit(0);
      await flush(); // the clock does not move: no backoff
      expect(h.spawn).toHaveBeenCalledTimes(run + 2);
      expect(argAfter(h.children[run + 1]!.args, '-start_number')).toBe(String(5 * run + 5));
      expect(argAfter(h.children[run + 1]!.args, '-hls_flags')).toContain('discont_start');
      expect(h.m.activeUpstreams(1)).toBe(1);
    }
    expect(alive(h.m, s.sessionId)).toBe(true);
    expect(restartDelays(h.logs)).toEqual([]);

    // The whole budget is still there: three backed-off restarts, and only the fourth failure gives up.
    for (const [i, delay] of [1_000, 2_000, 4_000].entries()) {
      h.children[5 + i]!.exit(1);
      await vi.advanceTimersByTimeAsync(delay);
      expect(h.spawn).toHaveBeenCalledTimes(7 + i);
    }
    expect(alive(h.m, s.sessionId)).toBe(true);
    h.children[8]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawn).toHaveBeenCalledTimes(9);
    expect(alive(h.m, s.sessionId)).toBe(false);
    expect(restartDelays(h.logs)).toEqual([1_000, 2_000, 4_000]);
  });

  test('a live run that produced segments and then failed (e.g. a Windows rename error) also reconnects at once', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);

    for (const [run, code] of [1, 255, null, 1, 1].entries()) {
      writePlaylist(outDir, 0, 5 * run + 4);
      await vi.advanceTimersByTimeAsync(12_000);
      const child = h.children[run]!;
      child.stderr.write('[hls @ 0x1] failed to rename file index.m3u8.tmp to index.m3u8: Operation not permitted\n');
      child.exit(code);
      await flush();
      expect(h.spawn).toHaveBeenCalledTimes(run + 2);
      expect(argAfter(h.children[run + 1]!.args, '-start_number')).toBe(String(5 * run + 5));
    }
    expect(alive(h.m, s.sessionId)).toBe(true);
    expect(restartDelays(h.logs)).toEqual([]);
  });

  test('a reconnect resets the consecutive-failure count; exactly 2 new segments over exactly 10 s is enough', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);

    h.children[0]!.exit(1); // nothing produced: failures
    await vi.advanceTimersByTimeAsync(1_000);
    h.children[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.spawn).toHaveBeenCalledTimes(3);

    writePlaylist(outDir, 0, 1); // two new segments
    await vi.advanceTimersByTimeAsync(10_000);
    h.children[2]!.exit(0);
    await flush();
    expect(h.spawn).toHaveBeenCalledTimes(4);
    expect(argAfter(h.children[3]!.args, '-start_number')).toBe('2');

    // Short runs again: the count starts from 0, so 1 s, 2 s, 4 s, and only then it gives up.
    for (const [i, delay] of [1_000, 2_000, 4_000].entries()) {
      h.children[3 + i]!.exit(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.spawn).toHaveBeenCalledTimes(4 + i);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.spawn).toHaveBeenCalledTimes(5 + i);
    }
    expect(alive(h.m, s.sessionId)).toBe(true);
    h.children[6]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawn).toHaveBeenCalledTimes(7);
    expect(alive(h.m, s.sessionId)).toBe(false);
    expect(restartDelays(h.logs)).toEqual([1_000, 2_000, 1_000, 2_000, 4_000]);
  });

  test('a long run that wrote only one new segment is a failure, not a reconnect', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);

    writePlaylist(outDir, 0, 0); // one new segment
    await vi.advanceTimersByTimeAsync(12_000); // long enough to reconnect, if it had written two
    h.children[0]!.exit(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawn).toHaveBeenCalledTimes(1); // backing off
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(argAfter(h.children[1]!.args, '-start_number')).toBe('1');
    expect(restartDelays(h.logs)).toEqual([1_000]);
    expect(h.logs.some((l) => l.m.includes('reconnecting'))).toBe(false);
  });

  test('a run shorter than 10 s is a failure however many segments it wrote; a longer one reconnects', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);

    // 2 s: five segments, but too quick to trust. A failure, with the 1 s backoff.
    await vi.advanceTimersByTimeAsync(2_000);
    writePlaylist(outDir, 0, 4);
    h.children[0]!.exit(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(argAfter(h.children[1]!.args, '-start_number')).toBe('5');

    // Just under 10 s: still a failure (2 s backoff).
    await vi.advanceTimersByTimeAsync(9_999);
    writePlaylist(outDir, 0, 9);
    h.children[1]!.exit(0);
    await flush();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.spawn).toHaveBeenCalledTimes(3);

    // 12 s: a reconnect, at once, and the two failures are forgiven.
    await vi.advanceTimersByTimeAsync(12_000);
    writePlaylist(outDir, 0, 14);
    h.children[2]!.exit(0);
    await flush();
    expect(h.spawn).toHaveBeenCalledTimes(4);
    expect(argAfter(h.children[3]!.args, '-start_number')).toBe('15');
    h.children[3]!.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.spawn).toHaveBeenCalledTimes(5);
    expect(restartDelays(h.logs)).toEqual([1_000, 2_000, 1_000]);
  });

  test('quick runs that each write five segments (an ending playlist read in half a second) still give up', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);

    for (const [run, delay] of [1_000, 2_000, 4_000, 0].entries()) {
      writePlaylist(outDir, 0, 5 * run + 4);
      await vi.advanceTimersByTimeAsync(500);
      h.children[run]!.exit(0);
      await vi.advanceTimersByTimeAsync(delay);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawn).toHaveBeenCalledTimes(4);
    expect(alive(h.m, s.sessionId)).toBe(false);
    expect(restartDelays(h.logs)).toEqual([1_000, 2_000, 4_000]);
    expect(h.logs.some((l) => l.m.includes('reconnecting'))).toBe(false);
    expect(h.logs).toContainEqual(expect.objectContaining({ m: 'ffmpeg keeps exiting; giving up' }));
  });

  test('a stall-watchdog kill stays a failure even when the run had produced segments', async () => {
    const h = harness({ liveIdleMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);

    for (let run = 0; run < 4; run++) {
      writePlaylist(outDir, 0, 5 * run + 4); // five new segments, then nothing more
      await vi.advanceTimersByTimeAsync(40_000); // seen, stalled for 20 s, killed, then the backoff (at most 4 s)
      expect(h.children[run]!.exited).toBe(true);
      expect(h.spawn).toHaveBeenCalledTimes(Math.min(run + 2, 4));
    }
    expect(alive(h.m, s.sessionId)).toBe(false);
    expect(restartDelays(h.logs)).toEqual([1_000, 2_000, 4_000]);
    expect(h.logs.filter((l) => l.m.includes('stalled'))).toHaveLength(4);
    expect(h.logs.some((l) => l.m.includes('reconnecting'))).toBe(false);
  });

  test("after a relaunch the old process's segments do not count as new progress", async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: 12_000 });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    await vi.advanceTimersByTimeAsync(12_000); // watchdog at 5 s and 10 s: nothing yet
    writePlaylist(outDir, 0, 4); // written, and the process gone, before the watchdog's next look
    h.children[0]!.exit(0);
    await flush();
    expect(h.spawn).toHaveBeenCalledTimes(2); // reconnected at 12 s; the new process writes nothing

    await vi.advanceTimersByTimeAsync(8_000); // watchdog at 15 s and 20 s: segment 4 is not progress
    expect(h.children[1]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); // 25 s: more than 12 s without a segment of its own
    expect(h.children[1]!.kills).toBe(1);
    await vi.advanceTimersByTimeAsync(1_050); // exit, then the 1 s backoff
    expect(h.spawn).toHaveBeenCalledTimes(3);
    expect(argAfter(h.children[2]!.args, '-start_number')).toBe('5');
  });

  // Ruling R33: a relaunched FFmpeg writes a fresh playlist and deletes only its own segments, so the
  // session deletes the ones the previous run left behind.
  test("after a live relaunch the previous run's segments go once the new playlist is up and a 10 s grace has passed", async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    writeSegments(outDir, 0, 4);
    writeSegments(outDir, 3, 4, 'm4s');
    writeFileSync(join(outDir, 'init.mp4'), 'x'); // the relaunch rewrites it
    writeFileSync(join(outDir, 'seg_00001.ts.tmp'), 'x'); // not a segment name
    writePlaylist(outDir, 0, 4);
    await vi.advanceTimersByTimeAsync(12_000);
    h.children[0]!.exit(0); // reconnects at once, from segment 5
    await flush();
    expect(argAfter(h.children[1]!.args, '-start_number')).toBe('5');

    // Until the new run has written its playlist, players are still on the old one.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(segmentFiles(outDir)).toHaveLength(7);

    writeSegments(outDir, 5, 6);
    writeSegments(outDir, 5, 5, 'm4s');
    writePlaylist(outDir, 5, 6);
    await vi.advanceTimersByTimeAsync(9_900); // a player may still be fetching the old run's last segments
    expect(segmentFiles(outDir)).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(5_200); // past the grace and the next housekeeping pass
    expect(readdirSync(outDir).sort()).toEqual([
      'index.m3u8',
      'init.mp4',
      'seg_00001.ts.tmp',
      'seg_00005.m4s',
      'seg_00005.ts',
      'seg_00006.ts',
    ]);
    expect(h.logs).toContainEqual({ level: 'info', m: 'removed old segments', o: { sessionId: s.sessionId, below: 5, deleted: 7 } });
    expect(alive(h.m, s.sessionId)).toBe(true);
  });

  test('a restart after a failure prunes too, and a session that stops before the grace is up deletes nothing more', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    writeSegments(outDir, 0, 2);
    writePlaylist(outDir, 0, 2);
    h.children[0]!.exit(1); // a quick failure: restarted after the 1 s backoff, from segment 3
    await vi.advanceTimersByTimeAsync(1_000);
    expect(argAfter(h.children[1]!.args, '-start_number')).toBe('3');
    writeSegments(outDir, 3, 3);
    writePlaylist(outDir, 3, 3);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(segmentFiles(outDir)).toEqual(['seg_00003.ts']);

    h.children[1]!.exit(1); // another failure: restarted after 2 s, from segment 4
    await vi.advanceTimersByTimeAsync(2_000);
    expect(argAfter(h.children[2]!.args, '-start_number')).toBe('4');
    writeSegments(outDir, 4, 4);
    writePlaylist(outDir, 4, 4);
    await vi.advanceTimersByTimeAsync(5_000); // the new playlist has been seen; the grace is running
    const released = h.m.release(s.sessionId, 'A');
    await vi.advanceTimersByTimeAsync(100);
    await released;
    await vi.waitFor(() => expect(existsSync(outDir)).toBe(false));

    // Whatever appears there now is not the stopped session's to delete.
    mkdirSync(outDir);
    writeSegments(outDir, 0, 3);
    writePlaylist(outDir, 9, 9);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(segmentFiles(outDir)).toEqual(segmentNames(0, 3));
    expect(h.logs.filter((l) => l.m === 'removed old segments')).toHaveLength(1);
  });

  test('runs shorter than the grace still have the runs before them pruned', async () => {
    const h = harness({ liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    let most = 0;
    for (let run = 0; run < 6; run++) {
      // Five segments at once, then 12 s until the input "ends" and FFmpeg is relaunched.
      writeSegments(outDir, 5 * run, 5 * run + 4);
      writePlaylist(outDir, 5 * run, 5 * run + 4);
      for (let t = 0; t < 12_000; t += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        most = Math.max(most, segmentFiles(outDir).length);
      }
      h.children[run]!.exit(0);
      await flush();
    }
    expect(h.spawn).toHaveBeenCalledTimes(7);
    // At most the current run and the two before it, which are still in their grace periods.
    expect(most).toBeLessThanOrEqual(15);

    writeSegments(outDir, 30, 34);
    writePlaylist(outDir, 30, 34);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(segmentFiles(outDir)).toEqual(segmentNames(30, 34));
    expect(alive(h.m, s.sessionId)).toBe(true);
  });

  // Ruling R29: a finite live playlist (ENDLIST) is swapped for the provider's continuous TS stream.
  test('a live playlist with a finite duration switches to the continuous stream, for the session and its relaunches', async () => {
    const probe = vi.fn(async (url: string, _userAgent: string) => (url.endsWith('.ts') ? LIVE_TS : FINITE_HLS));
    const h = harness({ probe, liveIdleMs: HOUR, stallTimeoutMs: HOUR });
    const req = liveWithFallback(1, 'A');
    const s = await h.m.start(req);

    expect(s.mode).toBe('hls');
    expect(probe.mock.calls.map(([url]) => url)).toEqual([req.sourceUrl, req.fallbackSourceUrl]);
    const args = h.children[0]!.args;
    expect(argAfter(args, '-i')).toBe(req.fallbackSourceUrl);
    expect(args).not.toContain('-http_multiple');
    expect(fallbackLogs(h.logs)).toEqual([
      { level: 'info', m: TRYING, o: { sessionId: s.sessionId, url: REDACTED_M3U8, fallback: REDACTED_TS, durationSec: 15 } },
      { level: 'info', m: SWITCHED, o: { sessionId: s.sessionId, url: REDACTED_TS } },
    ]);
    expect(h.logs.find((l) => l.m === 'session started')?.o).toMatchObject({ url: REDACTED_TS });

    h.children[0]!.exit(1); // a relaunch keeps the continuous stream
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(argAfter(h.children[1]!.args, '-i')).toBe(req.fallbackSourceUrl);
    expect(alive(h.m, s.sessionId)).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  test('a live playlist without a duration, or without a fallback, is played as it is', async () => {
    const h = harness(); // live HLS, no duration
    const req = liveWithFallback(1, 'A');
    await h.m.start(req);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(argAfter(h.children[0]!.args, '-i')).toBe(req.sourceUrl);
    expect(argAfter(h.children[0]!.args, '-http_multiple')).toBe('0');

    const finite = harness({ probe: async () => FINITE_HLS });
    await finite.m.start(live(2, 'B')); // no fallback offered
    expect(argAfter(finite.children[0]!.args, '-i')).toBe(live(2, 'B').sourceUrl);
    expect(fallbackLogs([...h.logs, ...finite.logs])).toEqual([]);
  });

  test('if the continuous stream cannot be probed, the finite playlist is played after all', async () => {
    const probe = vi.fn(async (url: string, _userAgent: string) => {
      if (url.endsWith('.ts')) throw new Error(`ffprobe failed for ${url}`);
      return FINITE_HLS;
    });
    const h = harness({ probe });
    const req = liveWithFallback(1, 'A');
    const s = await h.m.start(req);

    expect(s.mode).toBe('hls');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(argAfter(h.children[0]!.args, '-i')).toBe(req.sourceUrl);
    expect(argAfter(h.children[0]!.args, '-http_multiple')).toBe('0');
    expect(fallbackLogs(h.logs)).toEqual([
      { level: 'info', m: TRYING, o: { sessionId: s.sessionId, url: REDACTED_M3U8, fallback: REDACTED_TS, durationSec: 15 } },
      { level: 'warn', m: NOT_USED, o: { sessionId: s.sessionId, fallback: REDACTED_TS, reason: `ffprobe failed for ${REDACTED_TS}` } },
    ]);
    expect(h.logs.find((l) => l.m === 'session started')?.o).toMatchObject({ url: REDACTED_M3U8 });
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  test('a fallback that turns out to be a playlist as well is not used', async () => {
    // Some servers (the fake among them) answer every live extension with the same playlist. Reading HLS
    // through a .ts URL would also lose -http_multiple 0, so a one-stream provider would refuse FFmpeg.
    for (const fallback of [FINITE_HLS, LIVE_HLS]) {
      const probe = vi.fn(async (url: string, _userAgent: string) => (url.endsWith('.ts') ? fallback : FINITE_HLS));
      const h = harness({ probe });
      const req = liveWithFallback(1, 'A');
      const s = await h.m.start(req);

      expect(probe).toHaveBeenCalledTimes(2);
      expect(argAfter(h.children[0]!.args, '-i')).toBe(req.sourceUrl);
      expect(argAfter(h.children[0]!.args, '-http_multiple')).toBe('0');
      expect(fallbackLogs(h.logs)).toEqual([
        { level: 'info', m: TRYING, o: { sessionId: s.sessionId, url: REDACTED_M3U8, fallback: REDACTED_TS, durationSec: 15 } },
        { level: 'warn', m: NOT_USED, o: { sessionId: s.sessionId, fallback: REDACTED_TS, reason: 'fallback is also HLS' } },
      ]);
      expect(JSON.stringify(h.logs)).not.toContain('secret');
    }
  });

  test('one 15 s deadline covers the fallback probe too', async () => {
    const probe = (url: string) => (url.endsWith('.ts') ? delayed(10_000, LIVE_TS) : delayed(8_000, FINITE_HLS));
    const h = harness({ probe, maxConnections: () => 1 });
    let settled = false;
    const start = h.m.start(liveWithFallback(1, 'A')).finally(() => {
      settled = true;
    });
    const outcome = expect(start).rejects.toMatchObject({ code: 'STREAM_START_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(14_900); // the fallback probe has been running since 8 s
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200); // 15.1 s
    await outcome;
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.m.activeUpstreams(1)).toBe(1); // that ffprobe is still connected
    await vi.advanceTimersByTimeAsync(3_000); // 18.1 s: it has finished
    expect(h.m.activeUpstreams(1)).toBe(0);
    // Tried, but no switch is claimed.
    const sessionId = expect.any(String);
    expect(fallbackLogs(h.logs)).toEqual([
      { level: 'info', m: TRYING, o: { sessionId, url: REDACTED_M3U8, fallback: REDACTED_TS, durationSec: 15 } },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  // Ruling R16: liveness is per viewer.
  test('drops a viewer who stops fetching, so the remaining one can switch on a one-stream account', async () => {
    const h = harness({ maxConnections: () => 1, stallTimeoutMs: HOUR });
    const a = await h.m.start(live(1, 'A'));
    await h.m.start(live(1, 'B'));
    for (let t = 0; t < 20_000; t += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.m.touch(a.sessionId, 'A')).toBe(true); // only A's player keeps fetching
    }
    expect(h.logs).toContainEqual(
      expect.objectContaining({ m: 'viewer timed out', o: expect.objectContaining({ clientId: 'B' }) }),
    );
    expect(alive(h.m, a.sessionId)).toBe(true);
    expect(h.children[0]!.kills).toBe(0);

    const next = h.m.start(live(2, 'A'));
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toMatchObject({ mode: 'hls' });
    expect(h.events).toEqual(['spawn:1', 'kill:1', 'exit:1', 'spawn:2']);
  });

  test('a touch from a viewer who is not a member re-adds them', async () => {
    const h = harness();
    const s = await h.m.start(live(1, 'A'));
    expect(h.m.touch(s.sessionId, 'C')).toBe(true);

    await h.m.release(s.sessionId, 'A');
    expect(h.children[0]!.kills).toBe(0); // C is watching now
    const gone = h.m.release(s.sessionId, 'C');
    await vi.advanceTimersByTimeAsync(100);
    await gone;
    expect(h.children[0]!.exited).toBe(true);
    expect(h.m.touch(s.sessionId, 'C')).toBe(false); // a stopped session is not revived
  });

  test('rejects a clientId that is not 1-64 url-safe characters', async () => {
    const h = harness();
    for (const bad of ['', 'a b', '../x', 'a/b', 'x'.repeat(65), 'é']) {
      const err = await h.m.start(live(1, bad)).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(Error);
      expect(err, bad).not.toBeInstanceOf(PlaybackError);
    }
    expect(h.spawn).not.toHaveBeenCalled();

    const ok = await h.m.start(live(1, `Az_9-${'x'.repeat(59)}`)); // 64 characters
    expect(ok.url).toContain(`/Az_9-${'x'.repeat(59)}/index.m3u8`);
    expect(h.m.touch(ok.sessionId, 'a b')).toBe(false);
  });
});

describe('pruneSegments', () => {
  test('deletes only segment files numbered below the cut, and a missing directory is nothing to do', () => {
    const dir = join(transcodeDir, 'prune');
    mkdirSync(dir);
    writeSegments(dir, 8, 12);
    writeSegments(dir, 9, 10, 'm4s');
    for (const other of ['init.mp4', 'index.m3u8', 'seg_00001.ts.tmp', 'seg_x.ts', 'seg_00002.mp4']) writeFileSync(join(dir, other), 'x');

    expect(pruneSegments(dir, 10)).toEqual({ deleted: 3, failed: 0 }); // seg 8 and 9 (.ts), seg 9 (.m4s)
    expect(readdirSync(dir).sort()).toEqual([
      'index.m3u8',
      'init.mp4',
      'seg_00001.ts.tmp',
      'seg_00002.mp4',
      'seg_00010.m4s',
      'seg_00010.ts',
      'seg_00011.ts',
      'seg_00012.ts',
      'seg_x.ts',
    ]);
    expect(pruneSegments(join(transcodeDir, 'gone'), 10)).toEqual({ deleted: 0, failed: 0 });
  });
});

const realFfmpeg = process.env.TV_FFMPEG_PATH;

// Drives pruneSegments directly (as the session manager does after a relaunch), with two real FFmpeg runs.
describe.skipIf(!realFfmpeg)('pruneSegments with real FFmpeg', () => {
  const media = (name: string) => join(import.meta.dirname, '../../../tools/fake-xtream/media', name);
  const copyTs: HlsPlan = { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false };
  const copyHevc: HlsPlan = { ...copyTs, segment: 'fmp4', tagHvc1: true, audio: null };
  const listed = (dir: string) =>
    readFileSync(join(dir, 'index.m3u8'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l !== '' && !l.startsWith('#'));

  test.each([
    { input: 'raw.ts', plan: copyTs, ext: 'ts' },
    { input: 'hevc.mkv', plan: copyHevc, ext: 'm4s' },
  ])("a relaunch into the same dir leaves the first run's segments ($ext), which the prune removes", ({ input, plan, ext }) => {
    const outDir = join(transcodeDir, `relaunch-${ext}`);
    mkdirSync(outDir);
    const run = (startNumber: number) => {
      const args = buildFfmpegArgs({ url: media(input), userAgent: UA, plan, live: true, startAtSec: 0, outDir, startNumber });
      const r = spawnSync(realFfmpeg!, args, { encoding: 'utf8', windowsHide: true });
      expect(r.status, r.stderr).toBe(0); // each run exits at the end of its (finite) input
    };

    run(0);
    const first = segmentFiles(outDir);
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.every((f) => f.endsWith(`.${ext}`))).toBe(true);
    const next = Math.max(...first.map((f) => Number(SEGMENT_FILE.exec(f)![1]))) + 1; // as a relaunch continues

    run(next);
    const second = listed(outDir);
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(second.every((f) => Number(SEGMENT_FILE.exec(f)![1]) >= next)).toBe(true); // a fresh playlist
    expect(segmentFiles(outDir)).toEqual([...first, ...second].sort()); // FFmpeg alone leaves the first run's behind

    expect(pruneSegments(outDir, next)).toEqual({ deleted: first.length, failed: 0 });
    expect(segmentFiles(outDir)).toEqual([...second].sort());
    for (const f of second) expect(existsSync(join(outDir, f)), f).toBe(true);
    if (ext === 'm4s') expect(existsSync(join(outDir, 'init.mp4'))).toBe(true);
  });
});

describe('defaultIsReady', () => {
  test('is true once index.m3u8 lists a segment', async () => {
    const dir = join(transcodeDir, 'ready-check');
    mkdirSync(dir);
    expect(await defaultIsReady(dir)).toBe(false);
    writeFileSync(join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n');
    expect(await defaultIsReady(dir)).toBe(false);
    writePlaylist(dir, 0, 0);
    expect(await defaultIsReady(dir)).toBe(true);
  });
});
