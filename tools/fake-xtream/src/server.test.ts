import { gunzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateCatalogue, smallCatalogue } from './catalogue.ts';
import { startFakeXtream } from './server.ts';
import type { FakeXtream } from './server.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'media');
const api = (fake: FakeXtream, qs: string) => fetch(`${fake.url}/player_api.php?username=u&password=p${qs}`);

let fake: FakeXtream;

beforeAll(async () => {
  if (!existsSync(join(mediaDir, 'raw.ts'))) {
    throw new Error('Fake media is missing. Run: npm run make-media -w @tv/fake-xtream (needs TV_FFMPEG_PATH)');
  }
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue() });
});
afterAll(async () => {
  await fake?.close();
});

describe('fake xtream', () => {
  test('authenticates good credentials and reports max connections', async () => {
    const body = await (await fetch(`${fake.url}/player_api.php?username=u&password=p`)).json();
    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(body.user_info).toMatchObject({ auth: 1, status: 'Active', max_connections: '1' });
    expect(body.user_info.allowed_output_formats).toEqual(['m3u8', 'ts']);
    expect(Number(body.user_info.exp_date)).toBeGreaterThan(Date.now() / 1000);
  });

  test('rejects bad credentials with auth 0', async () => {
    const body = await (await fetch(`${fake.url}/player_api.php?username=u&password=nope`)).json();
    expect(body.user_info.auth).toBe(0);
  });

  test('serves categories and streams for each action', async () => {
    const liveCats = await (await api(fake, '&action=get_live_categories')).json();
    expect(liveCats).toHaveLength(3);
    expect(liveCats[0]).toMatchObject({ category_id: expect.any(String), category_name: expect.any(String) });
    const live = await (await api(fake, '&action=get_live_streams')).json();
    expect(live.map((s: { stream_id: string }) => s.stream_id)).toEqual(['1', '2', '3', '999']);
    expect(live[0]).toMatchObject({ num: expect.any(Number), stream_type: 'live', tv_archive: 1 });

    expect(await (await api(fake, '&action=get_vod_categories')).json()).toHaveLength(2);
    const vod = await (await api(fake, '&action=get_vod_streams')).json();
    expect(vod.map((s: { stream_id: string }) => s.stream_id)).toEqual(['1', '2', '3']);
    expect(vod[0]).toMatchObject({ stream_type: 'movie', container_extension: 'mkv' });

    expect(await (await api(fake, '&action=get_series_categories')).json()).toHaveLength(1);
    const series = await (await api(fake, '&action=get_series')).json();
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ series_id: '10' });

    const info = await (await api(fake, '&action=get_series_info&series_id=10')).json();
    expect(info.info).toBeTruthy();
    expect(info.episodes['1'].map((e: { id: string }) => e.id)).toEqual(['101', '102']);
    expect(info.episodes['2'].map((e: { id: string }) => e.id)).toEqual(['201']);
    expect(info.episodes['1'][0]).toMatchObject({ container_extension: 'mkv', season: 1, info: { duration_secs: expect.any(Number) } });
  });

  test('refuses a second concurrent media connection when the limit is 1', async () => {
    const a = await fetch(`${fake.url}/live/u/p/2.ts`);
    expect(a.status).toBe(200);
    expect(fake.openMediaConnections()).toBe(1);
    const refusedBefore = fake.refusedMediaRequests().length;
    const b = await fetch(`${fake.url}/live/u/p/2.ts`);
    expect(b.status).toBe(403);
    expect(fake.refusedMediaRequests().slice(refusedBefore)).toEqual([{ path: '/live/u/p/2.ts', heldBy: ['/live/u/p/2.ts'] }]);
    await a.body?.cancel();
    await vi_waitFor(() => fake.openMediaConnections() === 0);
    const c = await fetch(`${fake.url}/live/u/p/2.ts`);
    expect(c.status).toBe(200);
    await c.body?.cancel();
    await vi_waitFor(() => fake.openMediaConnections() === 0);
  });

  test('HLS playlist and segment requests count against the connection limit', async () => {
    const held = await fetch(`${fake.url}/live/u/p/2.ts`); // body left unread, so the connection stays open
    expect(fake.openMediaConnections()).toBe(1);
    const refusedBefore = fake.refusedMediaRequests().length;
    expect((await fetch(`${fake.url}/live/u/p/1.m3u8`)).status).toBe(403);
    expect((await fetch(`${fake.url}/hls/seg000.ts`)).status).toBe(403);
    expect(fake.refusedMediaRequests().slice(refusedBefore)).toEqual([
      { path: '/live/u/p/1.m3u8', heldBy: ['/live/u/p/2.ts'] },
      { path: '/hls/seg000.ts', heldBy: ['/live/u/p/2.ts'] },
    ]);
    await held.body?.cancel();
    await vi_waitFor(() => fake.openMediaConnections() === 0);

    const playlist = await fetch(`${fake.url}/live/u/p/1.m3u8`);
    expect(playlist.status).toBe(200);
    await playlist.text();
    const seg = await fetch(`${fake.url}/hls/seg000.ts`);
    expect(seg.status).toBe(200);
    await seg.arrayBuffer();
    await vi_waitFor(() => fake.openMediaConnections() === 0);
  });

  test('serves live TS like a live stream: no length and no ranges', async () => {
    const res = await fetch(`${fake.url}/live/u/p/2.ts`, { headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('accept-ranges')).toBeNull();
    await res.body?.cancel();
    await vi_waitFor(() => fake.openMediaConnections() === 0);
  });

  test('honours Range requests on movie files', async () => {
    const res = await fetch(`${fake.url}/movie/u/p/1.mkv`, { headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    await vi_waitFor(() => fake.openMediaConnections() === 0);
  });

  test('maps media by stream id, ignoring the extension', async () => {
    const res = await fetch(`${fake.url}/movie/u/p/2.mkv`);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    await res.body?.cancel();
    await vi_waitFor(() => fake.openMediaConnections() === 0);
  });

  test('serves the HLS playlist with segments under /hls/', async () => {
    const res = await fetch(`${fake.url}/live/u/p/1.m3u8`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const segs = text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segs.length).toBeGreaterThan(5);
    expect(segs[0]).toMatch(/^\/hls\/seg\d+\.ts$/);
    const seg = await fetch(`${fake.url}${segs[0]}`);
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    await vi_waitFor(() => fake.openMediaConnections() === 0);
  });

  test('returns 404 for the dead channel and 403 for bad media credentials', async () => {
    expect((await fetch(`${fake.url}/live/u/p/999.m3u8`)).status).toBe(404);
    expect((await fetch(`${fake.url}/live/u/bad/2.ts`)).status).toBe(403);
  });

  test('setCatalogue swaps the served catalogue', async () => {
    fake.setCatalogue(generateCatalogue({ live: 10, movie: 0, series: 0, categoriesPerKind: 2 }));
    const live = await (await api(fake, '&action=get_live_streams')).json();
    expect(live).toHaveLength(10);
    fake.setCatalogue(smallCatalogue());
  });
});

describe('generateCatalogue', () => {
  test('is deterministic and tags category names', () => {
    const counts = { live: 1000, movie: 500, series: 100, categoriesPerKind: 40 };
    const a = generateCatalogue(counts);
    const b = generateCatalogue(counts);
    expect(a.live.items.slice(0, 50)).toEqual(b.live.items.slice(0, 50));
    expect(a.live.items).toHaveLength(1000);
    expect(a.live.categories.some((c) => /^(UK|US|AR)\| /.test(c.name))).toBe(true);
    expect(a.movie.categories.some((c) => /^\|(EN|FR)\| /.test(c.name))).toBe(true);
    expect(a.live.categories.some((c) => !/^[A-Z]{2}\|/.test(c.name))).toBe(true);
  });
});

describe('paced fake xtream', () => {
  let paced: FakeXtream;
  beforeAll(async () => {
    paced = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), paced: true });
  });
  afterAll(async () => {
    await paced?.close();
  });

  test('streams raw.ts at its real bitrate, nowhere near its end where an unpaced stream has finished', async () => {
    const size = statSync(join(mediaDir, 'raw.ts')).size;
    const bitrate = size / 30; // bytes per second of the 30 s file
    const res = await fetch(`${paced.url}/live/u/p/2.ts`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let bytes = 0;
    const t0 = Date.now();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('a paced live stream must not end');
      bytes += value.length;
      if (Date.now() - t0 >= 3000) break;
    }
    const elapsed = (Date.now() - t0) / 1000;
    expect(bytes).toBeGreaterThan(bitrate * elapsed * 0.75);
    expect(bytes).toBeLessThan(bitrate * elapsed * 1.25);
    expect(bytes).toBeLessThan(size / 5);
    await reader.cancel();
    await vi_waitFor(() => paced.openMediaConnections() === 0);
  });

  test('loops a file back to its start, and ends an empty one', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-fake-wrap-'));
    try {
      const file = Buffer.alloc(188 * 50);
      for (let i = 0; i < file.length; i++) file[i] = i % 251;
      writeFileSync(join(dir, 'raw.ts'), file);
      writeFileSync(join(dir, 'mpeg2.ts'), '');
      const tiny = await startFakeXtream({ mediaDir: dir, paced: true, pacedMediaSeconds: 1 }); // 9.4 kB/s
      try {
        const res = await fetch(`${tiny.url}/live/u/p/2.ts`);
        const reader = res.body!.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (bytes < file.length * 2 + 100) {
          const { value, done } = await reader.read();
          if (done) throw new Error('a paced live stream must not end');
          chunks.push(Buffer.from(value));
          bytes += value.length;
        }
        await reader.cancel();
        const all = Buffer.concat(chunks);
        expect(all.subarray(0, file.length).equals(file)).toBe(true);
        expect(all.subarray(file.length, file.length * 2).equals(file)).toBe(true); // the bytes after the wrap

        await vi_waitFor(() => tiny.openMediaConnections() === 0); // the one slot frees on the server's close
        const empty = await fetch(`${tiny.url}/live/u/p/3.ts`, { signal: AbortSignal.timeout(3000) }); // a hang fails, not stalls
        expect(empty.status).toBe(200);
        expect((await empty.arrayBuffer()).byteLength).toBe(0);
      } finally {
        await tiny.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serves a sliding-window HLS playlist that advances with time and has no ENDLIST', async () => {
    const seq = async () => {
      const text = await (await fetch(`${paced.url}/live/u/p/1.m3u8`)).text();
      expect(text).not.toContain('#EXT-X-ENDLIST');
      expect(text.match(/^#EXTINF/gm)).toHaveLength(6);
      const uris = text.split('\n').filter((l) => l.startsWith('/hls/'));
      expect(uris[0]).toMatch(/^\/hls\/seg-live-\d+\.ts$/);
      return Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)![1]);
    };
    const a = await seq();
    await new Promise((r) => setTimeout(r, 4300));
    const b = await seq();
    expect(b - a).toBeGreaterThanOrEqual(2);
    expect(b - a).toBeLessThanOrEqual(3);
    const seg = await fetch(`${paced.url}/hls/seg-live-${b + 17}.ts`); // wraps over the 15 real files
    expect(seg.status).toBe(200);
    await seg.arrayBuffer();
  });

  test('marks the discontinuity where the loop wraps', async () => {
    const realNow = Date.now;
    const late = await startFakeXtream({ mediaDir, paced: true });
    Date.now = () => realNow() + 26_000; // newest sequence 5 + 13 = 18: the window 13..18 contains 15
    try {
      const text = await (await fetch(`${late.url}/live/u/p/1.m3u8`)).text();
      expect(text.match(/^#EXT-X-DISCONTINUITY$/gm)).toHaveLength(1);
      expect(text.indexOf('seg-live-14.ts')).toBeLessThan(text.indexOf('#EXT-X-DISCONTINUITY\n'));
      expect(text.indexOf('#EXT-X-DISCONTINUITY\n')).toBeLessThan(text.indexOf('seg-live-15.ts'));

      // Across a double wrap (sequence past 30) both counters only ever go up and DISCONTINUITY-SEQUENCE is exact.
      let lastMedia = -1;
      let lastDisc = -1;
      for (let secs = 0; secs <= 80; secs += 2) {
        Date.now = () => realNow() + secs * 1000;
        const pl = await (await fetch(`${late.url}/live/u/p/1.m3u8`)).text();
        const media = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(pl)![1]);
        const disc = Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(pl)![1]);
        expect(media).toBeGreaterThanOrEqual(lastMedia);
        expect(disc).toBeGreaterThanOrEqual(lastDisc);
        const uris = pl.split('\n').filter((l) => l.startsWith('/hls/'));
        const nums = uris.map((u) => Number(/seg-live-(\d+)/.exec(u)![1]));
        // Discontinuities before the first listed segment: one per multiple of 15 in 15..first-1.
        expect(disc).toBe(nums[0]! > 0 ? Math.floor((nums[0]! - 1) / 15) : 0);
        lastMedia = media;
        lastDisc = disc;
      }
      expect(lastDisc).toBeGreaterThanOrEqual(2); // past 30: two wraps behind the window
    } finally {
      Date.now = realNow;
      await late.close();
    }
  });
});

describe('guide, short epg, timeshift and timezone', () => {
  const NOW = Date.parse('2026-07-01T18:30:00Z');
  const withFake = async (opts: Partial<Parameters<typeof startFakeXtream>[0]>, fn: (f: FakeXtream) => Promise<void>) => {
    const f = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), now: () => NOW, ...opts });
    try {
      await fn(f);
    } finally {
      await f.close();
    }
  };
  const xml = (f: FakeXtream) => fetch(`${f.url}/xmltv.php?username=u&password=p`);
  const b64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

  test('xmltv lists linked channels and an hour grid of programmes', async () => {
    await withFake({}, async (f) => {
      const body = await (await xml(f)).text();
      expect(body).toContain('<channel id="hls.uk">');
      expect(body).toContain('<channel id="other.uk">');
      expect(body).toContain('<display-name>HLS Channel</display-name>');
      expect(body).toMatch(/<programme start="20260701180000 \+0000" stop="20260701190000 \+0000" channel="hls.uk">\s*<title>HLS Channel 18:00<\/title>/);
      const starts = [...body.matchAll(/<programme start="(\d{14})/g)].map((m) => m[1]!).sort();
      expect(starts[0]).toBe('20260628180000');
      expect(body.trimEnd().endsWith('</tv>')).toBe(true);
    });
  });

  test('gzip guide is raw gzip without content-encoding', async () => {
    await withFake({}, async (plain) => {
      const expected = await (await xml(plain)).text();
      await withFake({ guide: 'gzip' }, async (f) => {
        const res = await xml(f);
        expect(res.headers.get('content-encoding')).toBeNull();
        expect(res.headers.get('content-type')).toBe('application/xml');
        const raw = Buffer.from(await res.arrayBuffer());
        expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]);
        expect(gunzipSync(raw).toString('utf8')).toBe(expected);
      });
    });
  });

  test('guide modes none, error and truncated', async () => {
    await withFake({ guide: 'none' }, async (f) => expect((await xml(f)).status).toBe(404));
    await withFake({ guide: 'error' }, async (f) => expect((await xml(f)).status).toBe(500));
    await withFake({ guide: 'truncated' }, async (f) => {
      const res = await xml(f);
      expect(res.status).toBe(200);
      const text = await res.text().catch(() => '');
      expect(text.length).toBeGreaterThan(0);
      expect(text.trimEnd().endsWith('</tv>')).toBe(false);
    });
  });

  test('stall guide sends half and then nothing until the client leaves', async () => {
    await withFake({ guide: 'stall' }, async (f) => {
      const ctl = new AbortController();
      const res = await fetch(`${f.url}/xmltv.php?username=u&password=p`, { signal: ctl.signal });
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.value!.length).toBeGreaterThan(0);
      const next = await Promise.race([reader.read().then(() => 'data'), new Promise((r) => setTimeout(() => r('quiet'), 400))]);
      expect(next).toBe('quiet');
      ctl.abort();
    });
  });

  test('xmltv refuses wrong credentials', async () => {
    await withFake({}, async (f) => {
      expect((await fetch(`${f.url}/xmltv.php?username=u&password=bad`)).status).toBe(403);
    });
  });

  test('short epg decodes and limits', async () => {
    await withFake({}, async (f) => {
      const body = await (await api(f, '&action=get_short_epg&stream_id=1&limit=2')).json();
      expect(body.epg_listings).toHaveLength(2);
      const first = body.epg_listings[0];
      expect(b64(first.title)).toBe('HLS Channel 18:00');
      expect(b64(first.description)).toEqual(expect.any(String));
      expect(first.start_timestamp).toBe(String(Date.parse('2026-07-01T18:00:00Z') / 1000));
      expect(first.stop_timestamp).toBe(String(Date.parse('2026-07-01T19:00:00Z') / 1000));
      expect(first.start).toBe('2026-07-01 19:00:00'); // BST
      expect(first.channel_id).toBe('hls.uk');
      const dflt = await (await api(f, '&action=get_short_epg&stream_id=1')).json();
      expect(dflt.epg_listings).toHaveLength(4);
    });
  });

  test('data table covers the window; listings:false gives none', async () => {
    await withFake({}, async (f) => {
      const body = await (await api(f, '&action=get_simple_data_table&stream_id=1')).json();
      expect(body.epg_listings).toHaveLength(5 * 24 + 1); // 18:00 three days back to 18:00 two days ahead
      const none = await (await api(f, '&action=get_simple_data_table&stream_id=3')).json();
      expect(none.epg_listings ?? []).toEqual([]);
    });
    await withFake({ listings: false }, async (f) => {
      expect(await (await api(f, '&action=get_simple_data_table&stream_id=1')).json()).toEqual([]);
      expect(await (await api(f, '&action=get_simple_date_table&stream_id=1')).json()).toEqual([]);
    });
    await withFake({ tableAction: 'typo' }, async (f) => {
      const bad = await (await api(f, '&action=get_simple_data_table&stream_id=1')).json();
      expect(bad.epg_listings).toBeUndefined();
      expect(bad.error).toEqual(expect.any(String));
      const ok = await (await api(f, '&action=get_simple_date_table&stream_id=1')).json();
      expect(ok.epg_listings.length).toBeGreaterThan(0);
    });
  });

  test('server_info carries the timezone', async () => {
    await withFake({}, async (f) => {
      const body = await (await fetch(`${f.url}/player_api.php?username=u&password=p`)).json();
      expect(body.server_info.timezone).toBe('Europe/London');
      expect(body.server_info.time_now).toBe('2026-07-01 19:30:00');
      expect(body.server_info.timestamp_now).toBe(NOW / 1000);
    });
  });

  test('timeshift records the request and streams media', async () => {
    await withFake({}, async (f) => {
      const res = await fetch(`${f.url}/timeshift/u/p/60/2026-07-01:19-00/1.ts`);
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
      expect(f.timeshiftRequests()).toEqual([{ id: '1', start: '2026-07-01:19-00', durationMin: 60, ext: 'ts' }]);
      expect((await fetch(`${f.url}/timeshift/u/bad/60/2026-07-01:19-00/1.ts`)).status).toBe(403);
      expect((await fetch(`${f.url}/timeshift/u/p/60/2026-07-01:19-00/12345.ts`)).status).toBe(404);
      await vi_waitFor(() => f.openMediaConnections() === 0);
    });
  });

  test('timeshift counts against maxConnections', async () => {
    await withFake({}, async (f) => {
      const held = await fetch(`${f.url}/live/u/p/2.ts`);
      expect((await fetch(`${f.url}/timeshift/u/p/60/2026-07-01:19-00/1.ts`)).status).toBe(403);
      await held.body?.cancel();
      await vi_waitFor(() => f.openMediaConnections() === 0);
    });
  });

  test('live items carry epg id and archive', async () => {
    const live = await (await api(fake, '&action=get_live_streams')).json();
    expect(live[0]).toMatchObject({ epg_channel_id: 'hls.uk', tv_archive: 1, tv_archive_duration: 2 });
    expect(live[1]).toMatchObject({ epg_channel_id: 'raw.uk', tv_archive: 0, tv_archive_duration: 0 });
    expect(live[2]).toMatchObject({ epg_channel_id: '' });
  });

  test('generateCatalogue links guide channels and archive percent', () => {
    const c = generateCatalogue({ live: 20, movie: 0, series: 0, categoriesPerKind: 2, guideChannels: 10, archivePercent: 50 });
    expect(c.live.items[0]!.epgChannelId).toBe('ch1.gen');
    expect(c.live.items.filter((i) => i.epgChannelId)).toHaveLength(10);
    expect(c.live.items.filter((i) => i.archiveDays === 7)).toHaveLength(5);
    expect(c.live.items[15]!.epgChannelId).toBeUndefined();
  });
});

async function vi_waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
