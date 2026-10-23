import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { smallCatalogue } from '../../../../tools/fake-xtream/src/catalogue.ts';
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
    });
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
