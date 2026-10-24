import { existsSync } from 'node:fs';
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
    expect(live[0]).toMatchObject({ num: expect.any(Number), stream_type: 'live', tv_archive: 0 });

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

async function vi_waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
