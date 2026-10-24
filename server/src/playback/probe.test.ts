import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { redactUrl } from '../util/redact.ts';
import { createProber, parseFfprobe, withProbeLog } from './probe.ts';

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = resolve(here, '../../../tools/fake-xtream/media');
const fixture = (name: string): any => JSON.parse(readFileSync(resolve(here, 'fixtures', `${name}.json`), 'utf8'));

describe('parseFfprobe', () => {
  test('progressive h264 mkv with aac', () => {
    expect(parseFfprobe(fixture('h264-mkv'))).toEqual({
      formatName: 'matroska,webm',
      durationSec: 60.021,
      video: { codec: 'h264', codecTag: null, width: 640, height: 360, interlaced: false, fieldOrder: 'progressive' },
      audio: [{ index: 1, codec: 'aac', channels: 1 }],
    });
  });

  test('keeps the raw field order for the logs', () => {
    expect(parseFfprobe(fixture('h264-interlaced-ts')).video?.fieldOrder).toBe('tt');
    const f = fixture('h264-mkv');
    delete f.streams[0].field_order;
    expect(parseFfprobe(f).video?.fieldOrder).toBeNull();
  });

  test('keeps a real codec tag', () => {
    expect(parseFfprobe(fixture('hevc-mp4-hvc1')).video).toMatchObject({ codec: 'hevc', codecTag: 'hvc1' });
    expect(parseFfprobe(fixture('h264-mp4')).video?.codecTag).toBe('avc1');
  });

  test.each(['tt', 'bb', 'tb', 'bt'])('field_order %s is interlaced', (order) => {
    const f = fixture('h264-mkv');
    f.streams[0].field_order = order;
    expect(parseFfprobe(f).video?.interlaced).toBe(true);
  });

  test('tt fixture is interlaced; progressive or missing is not', () => {
    expect(parseFfprobe(fixture('h264-interlaced-ts')).video?.interlaced).toBe(true);
    const f = fixture('h264-mkv');
    delete f.streams[0].field_order;
    expect(parseFfprobe(f).video?.interlaced).toBe(false);
    expect(parseFfprobe(fixture('h264-mp4')).video?.interlaced).toBe(false);
  });

  test('N/A duration becomes null; no audio gives empty list', () => {
    const r = parseFfprobe(fixture('live-no-duration-no-audio'));
    expect(r.durationSec).toBeNull();
    expect(r.audio).toEqual([]);
    expect(r.video?.codec).toBe('mpeg2video');
  });

  test('audio index is the absolute stream index', () => {
    expect(parseFfprobe(fixture('dts-audio')).audio).toEqual([
      { index: 2, codec: 'dts', channels: 6 },
      { index: 3, codec: 'ac3', channels: 2 },
    ]);
  });

  test('audio-only input has null video', () => {
    const f = fixture('h264-mkv');
    f.streams = f.streams.slice(1);
    expect(parseFfprobe(f).video).toBeNull();
  });
});

describe('withProbeLog', () => {
  test('logs one redacted summary line per probe, saying whether it was cached', async () => {
    const lines: { o: object; m: string }[] = [];
    const log = { info: (o: object, m: string) => void lines.push({ o, m }), warn: () => {} };
    const result = parseFfprobe(fixture('h264-interlaced-ts'));
    const outcome = { result, cached: true };
    const probe = withProbeLog(async () => outcome, log);
    const url = 'http://provider.test/live/someuser/secret/7.ts?username=someuser&password=secret';

    expect(await probe(url, 'ua')).toBe(outcome);
    expect(lines).toHaveLength(1);
    const v = result.video!;
    expect(lines[0]!.m).toBe('probed');
    expect(lines[0]!.o).toEqual({
      url: 'http://provider.test/live/***/***/7.ts?username=***&password=***',
      container: result.formatName,
      video: `${v.codec} ${v.width}x${v.height} tt`,
      audio: result.audio.map((a) => a.codec).join(','),
      durationSec: result.durationSec,
      cached: true,
    });
    expect(JSON.stringify(lines)).not.toMatch(/secret|someuser/);
  });

  test('a probe that fails logs nothing and passes the error on', async () => {
    const lines: unknown[] = [];
    const log = { info: (o: object) => void lines.push(o), warn: (o: object) => void lines.push(o) };
    const probe = withProbeLog(async () => Promise.reject(new Error('nope')), log);
    await expect(probe('http://provider.test/live/u/secret/1.ts', 'ua')).rejects.toThrow('nope');
    expect(lines).toEqual([]);
  });
});

/** A stand-in for ffprobe that prints `json` and exits 0, counting its runs and keeping their arguments. */
function fakeFfprobe(json: unknown) {
  let runs = 0;
  const args: string[][] = [];
  const spawnFn = ((_cmd: string, a: string[]) => {
    runs++;
    args.push(a);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
    child.stdout.on('end', () => child.emit('close', 0));
    setImmediate(() => child.stdout.end(JSON.stringify(json)));
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, runs: () => runs, args };
}

describe('createProber', () => {
  const url = 'http://provider.test/movie/someuser/secret/7.mkv';
  const rows = (db: Db) => db.prepare('SELECT url_key, result FROM probe_cache ORDER BY url_key').all() as { url_key: string; result: string }[];

  test('says whether a result came from the cache, and invalidate forgets only that url', async () => {
    const db = openDb(':memory:');
    const ffprobe = fakeFfprobe(fixture('h264-mkv'));
    const prober = createProber({ ffprobePath: 'ffprobe', db, spawnFn: ffprobe.spawnFn });
    const result = parseFfprobe(fixture('h264-mkv'));
    const other = 'http://provider.test/movie/someuser/secret/8.mkv';

    expect(await prober.probe(url, 'ua')).toEqual({ result, cached: false });
    expect(await prober.probe(url, 'ua')).toEqual({ result, cached: true });
    await prober.probe(other, 'ua');
    expect(ffprobe.runs()).toBe(2);
    expect(rows(db).map((r) => r.url_key)).toEqual([redactUrl(url), redactUrl(other)]); // no credentials stored

    prober.invalidate(url); // given the real URL; the row is keyed by its redacted form
    expect(rows(db).map((r) => r.url_key)).toEqual([redactUrl(other)]);
    expect(await prober.probe(url, 'ua')).toEqual({ result, cached: false });
    expect(ffprobe.runs()).toBe(3);
    expect(await prober.probe(other, 'ua')).toEqual({ result, cached: true });
    prober.invalidate('http://provider.test/movie/someuser/secret/999.mkv'); // nothing cached: a no-op
  });

  test('reads from readFrom when given, but caches and forgets by the url', async () => {
    const db = openDb(':memory:');
    const ffprobe = fakeFfprobe(fixture('h264-mkv'));
    const prober = createProber({ ffprobePath: 'ffprobe', db, spawnFn: ffprobe.spawnFn });
    const relayUrl = (n: number) => `http://127.0.0.1:9/0f8fad5b-d9cb-469f-a165-7086772895${n}e/7.mkv`;

    expect((await prober.probe(url, 'ua', relayUrl(1))).cached).toBe(false);
    expect(ffprobe.args[0]!.at(-1)).toBe(relayUrl(1));
    expect(ffprobe.args[0]).not.toContain(url);
    expect(rows(db).map((r) => r.url_key)).toEqual([redactUrl(url)]);
    // The next session's relay URL is a new one, and the cached result is still found.
    expect((await prober.probe(url, 'ua', relayUrl(2))).cached).toBe(true);
    prober.invalidate(url);
    expect((await prober.probe(url, 'ua', relayUrl(3))).cached).toBe(false);
    expect(ffprobe.runs()).toBe(2);
  });

  test.each(['{"formatName":"hls",', 'null', '[]', '{"formatName":"hls"}'])(
    'a cached row that does not parse as a probe result (%s) is a miss: probed again and overwritten',
    async (corrupt) => {
      const db = openDb(':memory:');
      db.prepare('INSERT INTO probe_cache (url_key, result, probed_at) VALUES (?, ?, ?)').run(redactUrl(url), corrupt, Date.now());
      const ffprobe = fakeFfprobe(fixture('h264-mkv'));
      const prober = createProber({ ffprobePath: 'ffprobe', db, spawnFn: ffprobe.spawnFn });
      const result = parseFfprobe(fixture('h264-mkv'));

      expect(await prober.probe(url, 'ua')).toEqual({ result, cached: false });
      expect(ffprobe.runs()).toBe(1);
      expect(rows(db).map((r) => JSON.parse(r.result))).toEqual([result]);
      expect(await prober.probe(url, 'ua')).toEqual({ result, cached: true });
    },
  );

  test('failure message contains no URL', async () => {
    const db = openDb(':memory:');
    // node exits non-zero (bad option) so ffprobe "fails"
    const prober = createProber({ ffprobePath: process.execPath, db, timeoutMs: 5000 });
    const url = 'http://example.invalid/live/secretuser/secretpass/1.ts';
    const err = await prober.probe(url, 'ua').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/secretuser|secretpass|example\.invalid/);
  });
});

const ffprobePath = process.env.TV_FFPROBE_PATH;

describe.skipIf(!ffprobePath)('ffprobe integration', () => {
  let fake: FakeXtream;
  beforeAll(async () => {
    fake = await startFakeXtream({ mediaDir });
  });
  afterAll(async () => {
    await fake.close();
  });

  test('probes the mpeg2 live sample and caches the result', async () => {
    let spawns = 0;
    const spawnFn = ((...args: Parameters<typeof spawn>) => {
      spawns++;
      return spawn(...args);
    }) as typeof spawn;
    const db = openDb(':memory:');
    let t = 1_000_000;
    const prober = createProber({ ffprobePath: ffprobePath!, db, spawnFn, now: () => t });
    const url = `${fake.url}/live/u/p/3.ts`;

    const first = await prober.probe(url, 'test-agent');
    expect(first.cached).toBe(false);
    expect(first.result.video?.codec).toBe('mpeg2video');
    expect(spawns).toBe(1);

    const second = await prober.probe(url, 'test-agent');
    expect(second).toEqual({ result: first.result, cached: true });
    expect(spawns).toBe(1);

    const keys = db.prepare('SELECT url_key FROM probe_cache').all() as { url_key: string }[];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.url_key).not.toContain('/u/p/');

    t += 24 * 3600_000 + 1;
    await prober.probe(url, 'test-agent');
    expect(spawns).toBe(2);
  }, 30_000);
});
