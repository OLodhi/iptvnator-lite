import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProbeResult } from './probe.ts';
import { createSessionManager, defaultIsReady, PlaybackError } from './sessions.ts';
import type { ChildLike, SessionManager, SessionManagerDeps, StartRequest } from './sessions.ts';

const H264 = { codec: 'h264', codecTag: null, width: 1280, height: 720, interlaced: false };
const AAC = [{ index: 1, codec: 'aac', channels: 2 }];
const LIVE_HLS: ProbeResult = { formatName: 'hls', durationSec: null, video: H264, audio: AAC };
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
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

function writePlaylist(outDir: string, first: number, last: number): void {
  let text = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n';
  for (let i = first; i <= last; i++) text += `#EXTINF:3.000000,\nseg_${String(i).padStart(5, '0')}.ts\n`;
  writeFileSync(join(outDir, 'index.m3u8'), text);
}

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
      url: `/api/sessions/${a.sessionId}/index.m3u8`,
      durationSec: null,
      startAtSec: 0,
    });
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
    expect(h.m.touch(first.sessionId)).toBe(false);
    expect(h.m.touch(second.sessionId)).toBe(true);
    expect(existsSync(join(transcodeDir, first.sessionId))).toBe(false);
  });

  test('keeps a shared session alive for its other viewers', async () => {
    const h = harness();
    const s1 = await h.m.start(live(1, 'A'));
    await h.m.start(live(1, 'B'));
    await h.m.start(live(2, 'A'));

    expect(h.children[0]!.kills).toBe(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.m.touch(s1.sessionId)).toBe(true);

    // When the last viewer leaves, it goes.
    const released = h.m.release(s1.sessionId, 'B');
    await vi.advanceTimersByTimeAsync(100);
    await released;
    expect(h.children[0]!.exited).toBe(true);
    expect(h.m.touch(s1.sessionId)).toBe(false);
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
    expect(h.m.touch(l.sessionId)).toBe(false);

    await vi.advanceTimersByTimeAsync(35_000); // 55 s
    expect(h.children[1]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); // 60 s idle
    expect(h.children[1]!.kills).toBe(1);
    expect(h.m.touch(v.sessionId)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => {
      expect(existsSync(liveDir)).toBe(false);
      expect(existsSync(vodDir)).toBe(false);
    });

    // touch() resets the idle clock.
    const t = harness();
    const s = await t.m.start(live(2, 'C'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.m.touch(s.sessionId)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.children[0]!.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); // 20 s since the touch
    expect(t.children[0]!.kills).toBe(1);
  });

  test('restarts a live process that dies, continuing segment numbers, at most 3 times', async () => {
    const h = harness();
    const s = await h.m.start(live(1, 'A'));
    const outDir = outDirOf(h.m, s.sessionId);
    expect(h.children[0]!.args).not.toContain('-start_number');

    writePlaylist(outDir, 0, 4);
    h.children[0]!.exit(1);
    await flush();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(argAfter(h.children[1]!.args, '-start_number')).toBe('5');
    expect(argAfter(h.children[1]!.args, '-hls_flags')).toContain('discont_start');

    writePlaylist(outDir, 5, 9);
    h.children[1]!.exit(0);
    await flush();
    expect(argAfter(h.children[2]!.args, '-start_number')).toBe('10');

    writePlaylist(outDir, 10, 12);
    h.children[2]!.exit(1);
    await flush();
    expect(argAfter(h.children[3]!.args, '-start_number')).toBe('13');
    expect(h.m.touch(s.sessionId)).toBe(true);

    h.children[3]!.exit(1);
    await flush();
    expect(h.spawn).toHaveBeenCalledTimes(4);
    expect(h.m.touch(s.sessionId)).toBe(false);
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
      url: `/api/sessions/${s.sessionId}/direct`,
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

  test('stopAll kills every child and empties the transcode dir', async () => {
    const h = harness();
    await h.m.start(live(1, 'A'));
    await h.m.start(live(2, 'B'));
    await h.m.start(movie(1, 'C'));
    writeFileSync(join(transcodeDir, 'stray.txt'), 'left over');

    const stopped = h.m.stopAll();
    await vi.advanceTimersByTimeAsync(100);
    await stopped;

    expect(h.children).toHaveLength(3);
    expect(h.children.every((c) => c.kills === 1 && c.exited)).toBe(true);
    expect(readdirSync(transcodeDir)).toEqual([]);
    expect(h.m.activeUpstreams(1)).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // reap interval cleared
    await expect(h.m.start(live(1, 'A'))).rejects.toBeInstanceOf(PlaybackError);
    expect(h.spawn).toHaveBeenCalledTimes(3);
  });

  test('empties the transcode dir on creation', () => {
    mkdirSync(join(transcodeDir, 'old-session'));
    writeFileSync(join(transcodeDir, 'old-session', 'seg_00001.ts'), 'x');
    writeFileSync(join(transcodeDir, 'stray.txt'), 'x');
    harness();
    expect(readdirSync(transcodeDir)).toEqual([]);
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
    expect(h.m.touch(r1.sessionId)).toBe(false);
    expect(h.m.touch(r2.sessionId)).toBe(true);
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
    expect(h.m.touch(a.sessionId)).toBe(true);
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
    expect(h.m.touch(s.sessionId)).toBe(true);
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
