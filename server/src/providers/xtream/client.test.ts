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
