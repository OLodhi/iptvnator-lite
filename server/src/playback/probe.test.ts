import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { openDb } from '../db/db.ts';
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
  test('logs one redacted summary line per probe', async () => {
    const lines: { o: object; m: string }[] = [];
    const log = { info: (o: object, m: string) => void lines.push({ o, m }), warn: () => {} };
    const result = parseFfprobe(fixture('h264-interlaced-ts'));
    const probe = withProbeLog(async () => result, log);
    const url = 'http://provider.test/live/someuser/secret/7.ts?username=someuser&password=secret';

    expect(await probe(url, 'ua')).toBe(result);
    expect(lines).toHaveLength(1);
    const v = result.video!;
    expect(lines[0]!.m).toBe('probed');
    expect(lines[0]!.o).toEqual({
      url: 'http://provider.test/live/***/***/7.ts?username=***&password=***',
      container: result.formatName,
      video: `${v.codec} ${v.width}x${v.height} tt`,
      audio: result.audio.map((a) => a.codec).join(','),
      durationSec: result.durationSec,
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

describe('createProber', () => {
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
    expect(first.video?.codec).toBe('mpeg2video');
    expect(spawns).toBe(1);

    const second = await prober.probe(url, 'test-agent');
    expect(second).toEqual(first);
    expect(spawns).toBe(1);

    const keys = db.prepare('SELECT url_key FROM probe_cache').all() as { url_key: string }[];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.url_key).not.toContain('/u/p/');

    t += 24 * 3600_000 + 1;
    await prober.probe(url, 'test-agent');
    expect(spawns).toBe(2);
  }, 30_000);
});
