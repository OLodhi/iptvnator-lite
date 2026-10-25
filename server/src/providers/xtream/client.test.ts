import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { richCatalogue, smallCatalogue } from '../../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../../tools/fake-xtream/src/server.ts';
import { createXtreamClient } from './client.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tools/fake-xtream/media');
const userAgent = 'TiviMate/4.7.0';
let fake: FakeXtream;
let client: ReturnType<typeof createXtreamClient>;

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue() });
  client = createXtreamClient({ serverUrl: fake.url, username: 'u', password: 'p' }, { userAgent });
});
afterAll(async () => {
  await fake?.close();
});

async function withServer(
  handler: Parameters<typeof createServer>[1],
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const clientFor = (serverUrl: string, timeoutMs = 200) =>
  createXtreamClient({ serverUrl, username: 'u', password: 'p' }, { userAgent, timeoutMs });

async function collect(it: AsyncIterable<{ remoteId: string }>, into: string[]): Promise<void> {
  for await (const i of it) into.push(i.remoteId);
}

describe('xtream client streaming and errors', () => {
  test('malformed body mid-array yields earlier items then PROVIDER_BAD_RESPONSE', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[{"stream_id":1,"name":"A"},{"stream_id":2,"na}}}');
      },
      async (url) => {
        const got: string[] = [];
        await expect(collect(clientFor(url).streamItems('live'), got)).rejects.toMatchObject({ code: 'PROVIDER_BAD_RESPONSE' });
        expect(got).toEqual(['1']);
      },
    );
  });

  test('a slow body that keeps trickling is not cut off by timeoutMs', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const parts = ['[', '{"stream_id":1,"name":"A"},', '{"stream_id":2,"name":"B"},', '{"stream_id":3,"name":"C"}', ']'];
        let i = 0;
        const t = setInterval(() => {
          res.write(parts[i++]!);
          if (i === parts.length) {
            clearInterval(t);
            res.end();
          }
        }, 100);
        res.on('close', () => clearInterval(t));
      },
      async (url) => {
        const got: string[] = [];
        await collect(clientFor(url, 250).streamItems('live'), got);
        expect(got).toEqual(['1', '2', '3']);
      },
    );
  });

  test('a stalled body raises PROVIDER_UNREACHABLE', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('[{"stream_id":1,"name":"A"},');
      },
      async (url) => {
        await expect(collect(clientFor(url).streamItems('live'), [])).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
      },
    );
  });

  test.each([401, 403])('HTTP %i maps to PROVIDER_AUTH_FAILED', async (status) => {
    await withServer(
      (_req, res) => res.writeHead(status).end(),
      async (url) => {
        await expect(clientFor(url).authenticate()).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
        await expect(collect(clientFor(url).streamItems('live'), [])).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
      },
    );
  });
});

describe('xtream client', () => {
  test('authenticate returns account details', async () => {
    expect(await client.authenticate()).toEqual({
      status: 'Active', maxConnections: 1, expiresAt: expect.any(Number), allowedOutputFormats: ['m3u8', 'ts'],
      timezone: 'Europe/London',
    });
  });

  test('authenticate reports the provider timezone', async () => {
    expect((await client.authenticate()).timezone).toBe('Europe/London');
  });

  test('bad credentials raise PROVIDER_AUTH_FAILED', async () => {
    const bad = createXtreamClient({ serverUrl: fake.url, username: 'u', password: 'wrong' }, { userAgent });
    await expect(bad.authenticate()).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  });

  test('closed port raises PROVIDER_UNREACHABLE without leaking credentials', async () => {
    const down = createXtreamClient({ serverUrl: 'http://127.0.0.1:1', username: 'bob', password: 's3cret' }, { userAgent });
    const err = await down.authenticate().catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    expect(err.message).not.toContain('s3cret');
  });

  test('rejects non-JSON responses with PROVIDER_BAD_RESPONSE', async () => {
    const fetchFn = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    const c = createXtreamClient({ serverUrl: fake.url, username: 'u', password: 'p' }, { userAgent, fetchFn });
    await expect(c.authenticate()).rejects.toMatchObject({ code: 'PROVIDER_BAD_RESPONSE' });
    await expect(c.getCategories('live')).rejects.toMatchObject({ code: 'PROVIDER_BAD_RESPONSE' });
  });

  test('sends the User-Agent header', async () => {
    let seen: string | null = null;
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('user-agent');
      return new Response('{"user_info":{"auth":1}}');
    }) as typeof fetch;
    await createXtreamClient({ serverUrl: fake.url, username: 'u', password: 'p' }, { userAgent, fetchFn }).authenticate();
    expect(seen).toBe(userAgent);
  });

  test('getCategories maps ids and names', async () => {
    const cats = await client.getCategories('live');
    expect(cats.length).toBeGreaterThan(0);
    expect(cats[0]).toEqual({ remoteId: expect.any(String), name: expect.any(String) });
  });

  test('streamItems yields every item without buffering the array', async () => {
    const ids: string[] = [];
    for await (const item of client.streamItems('live')) ids.push(item.remoteId);
    expect(ids).toEqual(['1', '2', '3', '999']);
  });

  test('getSeriesInfo groups episodes by season in order', async () => {
    const info = await client.getSeriesInfo('10');
    expect(info.seasons.map((s) => s.season)).toEqual([1, 2]);
    expect(info.seasons.map((s) => s.episodes.map((e) => e.remoteId))).toEqual([['101', '102'], ['201']]);
  });

  test('URL builders embed credentials in the Xtream path format', () => {
    expect(client.liveUrl('7', 'm3u8')).toBe(`${fake.url}/live/u/p/7.m3u8`);
    expect(client.movieUrl('1', 'mkv')).toBe(`${fake.url}/movie/u/p/1.mkv`);
    expect(client.episodeUrl('101', 'mkv')).toBe(`${fake.url}/series/u/p/101.mkv`);
  });
});

describe('xtream guide and timeshift calls', () => {
  async function text(r: AsyncIterable<Buffer | string>): Promise<string> {
    let out = '';
    for await (const c of r) out += c.toString();
    return out;
  }

  async function withFake(opts: Parameters<typeof startFakeXtream>[0], run: (f: FakeXtream) => Promise<void>): Promise<void> {
    const f = await startFakeXtream(opts);
    try {
      await run(f);
    } finally {
      await f.close();
    }
  }

  test('xmltv streams the guide', async () => {
    expect(await text(await client.xmltv())).toContain('<tv');
  });

  test('xmltv idles out', async () => {
    await withFake({ mediaDir, guide: 'stall' }, async (f) => {
      const c = createXtreamClient({ serverUrl: f.url, username: 'u', password: 'p' }, { userAgent });
      const started = Date.now();
      await expect(text(await c.xmltv({ idleTimeoutMs: 200 }))).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  test('epgTable decodes listings', async () => {
    const list = await client.epgTable('1');
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.title).toContain(' ');
    for (const l of list) expect(l.stop).toBeGreaterThan(l.start);
    expect(list.map((l) => l.start)).toEqual([...list.map((l) => l.start)].sort((a, b) => a - b));
    expect(Number.isInteger(list[0]!.start)).toBe(true);
  });

  test('epgTable falls back to the typo endpoint', async () => {
    await withFake({ mediaDir, tableAction: 'typo' }, async (f) => {
      const c = createXtreamClient({ serverUrl: f.url, username: 'u', password: 'p' }, { userAgent });
      expect((await c.epgTable('1')).length).toBeGreaterThan(0);
    });
  });

  test('timeshiftUrl matches IPTVnator', () => {
    const c = createXtreamClient({ serverUrl: 'http://h:80/', username: 'u', password: 'p/q' }, { userAgent });
    const start = Date.UTC(2026, 6, 1, 18, 0) / 1000;
    expect(c.timeshiftUrl('7', start, start + 3600, 'Europe/London', 'ts')).toBe(
      'http://h:80/timeshift/u/p%2Fq/60/2026-07-01:19-00/7.ts',
    );
    expect(c.timeshiftUrl('7', start, start + 29 * 60 + 36, null, 'ts')).toContain('/30/2026-07-01:18-00/');
    expect(c.timeshiftUrl('7', start, start + 20, null, 'ts')).toContain('/1/');
    expect(c.timeshiftUrl('7', start, start + 3600, null, 'm3u8')).toMatch(/\/7\.m3u8$/);
  });

  test('destroying an unread xmltv stream cleans up without an unhandled error', async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown) => void unhandled.push(e);
    process.on('uncaughtException', record);
    process.on('unhandledRejection', record);
    let closed!: () => void;
    const serverSawClose = new Promise<void>((r) => (closed = r));
    try {
      await withServer(
        (_req, res) => {
          res.writeHead(200);
          res.write('<tv>');
          res.on('close', closed);
        },
        async (url) => {
          const stream = await clientFor(url).xmltv({ idleTimeoutMs: 100 });
          stream.destroy();
          await Promise.race([
            serverSawClose,
            new Promise((_, no) => setTimeout(() => no(new Error('server never saw the connection close')), 2000)),
          ]);
          await new Promise((r) => setTimeout(r, 300)); // past the idle timeout: nothing may fire
        },
      );
    } finally {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  test('xmltv does not idle out while the consumer applies backpressure', async () => {
    let resumed!: () => void;
    const consumerResumed = new Promise<void>((r) => (resumed = r));
    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.write('x'.repeat(2_000_000));
        // Ends only once the consumer reads again, so load cannot make the end race the pause.
        void consumerResumed.then(() => setTimeout(() => res.end('<tv/>'), 50));
      },
      async (url) => {
        const stream = await clientFor(url, 5000).xmltv({ idleTimeoutMs: 200 });
        await new Promise((r) => setTimeout(r, 800)); // not reading, four idle timeouts long
        resumed();
        let n = 0;
        for await (const c of stream) n += (c as Buffer).length;
        expect(n).toBe(2_000_005);
      },
    );
  });

  test('xmltv: a caller abort rejects as an abort and consumer errors pass through', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.write('<tv>');
      },
      async (url) => {
        const ac = new AbortController();
        const stream = await clientFor(url, 5000).xmltv({ signal: ac.signal });
        const failed = (async () => {
          for await (const _ of stream) void _;
        })();
        setTimeout(() => ac.abort(), 50);
        await expect(failed).rejects.toMatchObject({ name: 'AbortError' });

        const mine = new Error('consumer says stop');
        const stream2 = await clientFor(url, 5000).xmltv();
        setTimeout(() => stream2.destroy(mine), 50);
        await expect(
          (async () => {
            for await (const _ of stream2) void _;
          })(),
        ).rejects.toBe(mine);
      },
    );
  });

  test('epgTable returns [] when the provider has no listings', async () => {
    await withFake({ mediaDir, listings: false }, async (f) => {
      const c = createXtreamClient({ serverUrl: f.url, username: 'u', password: 'p' }, { userAgent });
      expect(await c.epgTable('1')).toEqual([]);
    });
  });

  test('epgTable does not retry after an auth failure', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls++;
        res.writeHead(403).end();
      },
      async (url) => {
        await expect(clientFor(url).epgTable('1')).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
        expect(calls).toBe(1);
      },
    );
  });

  test('epgTable accepts epg_listings as an object of listings (PHP sparse array)', async () => {
    const l = (n: number) => ({ title: 'Some show', start_timestamp: String(n), stop_timestamp: String(n + 60) });
    await withServer(
      (_req, res) => {
        res.writeHead(200).end(JSON.stringify({ epg_listings: { '3': l(300), '0': l(100) } }));
      },
      async (url) => {
        expect((await clientFor(url).epgTable('1')).map((x) => x.start)).toEqual([100, 300]);
      },
    );
  });

  test('credentials never leak from the idle, unreachable and 500 paths', async () => {
    const creds = { username: 'bob-secret-user', password: 'hunter2-secret-pw' };
    const check = (err: { message: string; stack?: string }) => {
      for (const s of Object.values(creds)) {
        expect(err.message).not.toContain(s);
        expect(err.stack ?? '').not.toContain(s);
      }
    };
    const at = (serverUrl: string, timeoutMs = 2000) => createXtreamClient({ serverUrl, ...creds }, { userAgent, timeoutMs });
    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.write('<tv>');
      },
      async (url) => {
        const err = await text(await at(url).xmltv({ idleTimeoutMs: 100 })).catch((e) => e);
        expect(err).toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
        check(err);
      },
    );
    const down = await at('http://127.0.0.1:1').xmltv().catch((e) => e);
    expect(down).toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    check(down);
    await withFake({ mediaDir, username: creds.username, password: creds.password, guide: 'error' }, async (f) => {
      const err = await at(f.url).xmltv().catch((e) => e);
      expect(err).toMatchObject({ code: 'PROVIDER_BAD_RESPONSE' });
      check(err);
    });
  });

  test('credentials never appear in thrown errors', async () => {
    await withFake({ mediaDir, username: 'alice-secret', password: 'p4ss-secret' }, async (f) => {
      const c = createXtreamClient({ serverUrl: f.url, username: 'alice-secret', password: 'wrong-pass' }, { userAgent });
      const err = await c.xmltv().catch((e) => e);
      expect(err).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
      for (const secret of ['alice-secret', 'p4ss-secret', 'wrong-pass']) {
        expect(err.message).not.toContain(secret);
        expect(err.stack).not.toContain(secret);
      }
    });
  });
});

describe('xtream series and movie details', () => {
  let rich: FakeXtream;
  let richClient: ReturnType<typeof createXtreamClient>;
  beforeAll(async () => {
    rich = await startFakeXtream({ mediaDir, catalogue: richCatalogue() });
    richClient = createXtreamClient({ serverUrl: rich.url, username: 'u', password: 'p' }, { userAgent });
  });
  afterAll(async () => {
    await rich?.close();
  });

  test('getSeriesInfo reads meta, season covers and episode stills', async () => {
    const info = await richClient.getSeriesInfo('11');
    expect(info.meta).toEqual({
      name: 'EN - THE KITCHEN (2022)',
      plot: 'A chef takes over a busy kitchen.',
      genre: 'Drama / Comedy',
      cast: 'Ann Lee, Bo Chan',
      director: 'Cy Dee',
      releaseDate: '2022-06-23',
      rating: '8',
      coverUrl: `${rich.url}/images/poster.png`,
      backdropUrls: [`${rich.url}/images/backdrop.png`],
    });
    expect(info.seasonMeta).toEqual({ 1: { name: 'Season 1', coverUrl: `${rich.url}/images/s1.png` } });
    expect(info.seasons.map((s) => s.season)).toEqual([0, 1, 2]);
    expect(info.seasons[1]!.episodes[0]).toEqual({
      remoteId: '111',
      title: 'EN - THE KITCHEN (2022) - S01E01 - Pilot',
      episodeNum: 1,
      containerExt: 'mkv',
      durationSec: 30,
      imageUrl: `${rich.url}/images/ep111.png`,
      airDate: '2022-06-23',
      width: 1920,
      height: 1080,
    });
  });

  test('getVodInfo reads movie details', async () => {
    expect(await richClient.getVodInfo('5')).toEqual({
      plot: 'Two languages, two subtitles.',
      genre: 'Test',
      cast: 'A, B',
      director: 'C',
      releaseDate: '2021-01-01',
      rating: '7',
      coverUrl: `${rich.url}/images/poster.png`,
      backdropUrls: [`${rich.url}/images/backdrop.png`],
      durationSec: 30,
    });
    expect(await richClient.getVodInfo('1')).toMatchObject({ plot: null, coverUrl: null, backdropUrls: [], durationSec: null });
  });

  test('non-http image values become null', async () => {
    const body = {
      info: { name: 'X', cover: 'javascript:alert(1)', backdrop_path: ['file:///etc/passwd', 'https://img.example/b.jpg', 5] },
      seasons: [{ season_number: 1, name: 'One', cover: 'data:image/png;base64,AAAA' }],
      episodes: { '1': [{ id: 7, episode_num: 1, title: 'T', info: { movie_image: '/relative.png' } }] },
    };
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
      async (url) => {
        const info = await clientFor(url).getSeriesInfo('1');
        expect(info.meta.coverUrl).toBeNull();
        expect(info.meta.backdropUrls).toEqual(['https://img.example/b.jpg']);
        expect(info.seasonMeta[1]).toEqual({ name: 'One', coverUrl: null });
        expect(info.seasons[0]!.episodes[0]!.imageUrl).toBeNull();
      },
    );
  });

  test('a bare-string backdrop and an empty-array info are tolerated', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url?.includes('get_vod_info') ? { info: [] } : { info: { backdrop_path: 'http://h/b.jpg' }, episodes: [] }));
      },
      async (url) => {
        expect((await clientFor(url).getSeriesInfo('1')).meta.backdropUrls).toEqual(['http://h/b.jpg']);
        expect(await clientFor(url).getVodInfo('1')).toMatchObject({ plot: null, backdropUrls: [] });
      },
    );
  });
});
