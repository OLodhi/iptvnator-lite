import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { generateCatalogue, smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { buildApp } from '../app.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

let fake: FakeXtream;
let app: FastifyInstance;
let providerId: number;

async function sync(): Promise<void> {
  const db = openDb(':memory:');
  const config = testConfig();
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  const catalogue = createCatalogueRepo(db);
  app = await buildApp({
    config, db, providers, catalogue,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions(),
  });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
}

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue() });
  await sync();
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

const get = (url: string) => app.inject({ method: 'GET', url });

test('categories come back in provider order with item counts', async () => {
  const res = await get(`/api/providers/${providerId}/categories?kind=live`);
  expect(res.statusCode).toBe(200);
  expect(res.json().map((c: { name: string }) => c.name)).toEqual(['UK| General', 'US| News', 'Misc']);
  expect(res.json().map((c: { itemCount: number }) => c.itemCount)).toEqual([2, 1, 1]);
  expect((await get(`/api/providers/999/categories?kind=live`)).statusCode).toBe(404);
  expect((await get(`/api/providers/${providerId}/categories?kind=bogus`)).statusCode).toBe(400);
});

test('paging returns every item exactly once', async () => {
  const cat = generateCatalogue({ live: 23, movie: 0, series: 0, categoriesPerKind: 1 });
  fake.setCatalogue(cat);
  await app.close();
  await sync();
  const [category] = (await get(`/api/providers/${providerId}/categories?kind=live`)).json();
  expect(category.itemCount).toBe(23);

  const ids: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await get(`/api/categories/${category.id}/items?limit=7${cursor ? `&cursor=${cursor}` : ''}`);
    const page: { items: { id: number }[]; nextCursor: string | null } = res.json();
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(4);
  expect(new Set(ids).size).toBe(23);
  expect(ids).toHaveLength(23);
  expect((await get(`/api/categories/${category.id}/items?cursor=!!!`)).statusCode).toBe(400);
});

test('limit is capped at 500 and defaults to 100', async () => {
  fake.setCatalogue(generateCatalogue({ live: 650, movie: 0, series: 0, categoriesPerKind: 1 }));
  await app.close();
  await sync();
  const [category] = (await get(`/api/providers/${providerId}/categories?kind=live`)).json();
  const big = (await get(`/api/categories/${category.id}/items?limit=10000`)).json();
  expect(big.items).toHaveLength(500);
  expect(big.nextCursor).not.toBeNull();
  const def = (await get(`/api/categories/${category.id}/items`)).json();
  expect(def.items).toHaveLength(100);
});

test('seasons are grouped and ordered', async () => {
  fake.setCatalogue(smallCatalogue());
  await app.close();
  await sync();
  const [cat] = (await get(`/api/providers/${providerId}/categories?kind=series`)).json();
  const { items } = (await get(`/api/categories/${cat.id}/items`)).json();
  const res = await get(`/api/items/${items[0].id}/seasons`);
  expect(res.statusCode).toBe(200);
  expect(res.json().map((s: { season: number; episodes: { remoteId: string }[] }) => [s.season, s.episodes.map((e) => e.remoteId)])).toEqual([
    [1, ['101', '102']],
    [2, ['201']],
  ]);
  expect(res.json()[0].episodes[0]).toMatchObject({ title: 'Pilot', episodeNum: 1 });
  const [live] = (await get(`/api/providers/${providerId}/categories?kind=live`)).json();
  const liveItem = (await get(`/api/categories/${live.id}/items`)).json().items[0];
  expect((await get(`/api/items/${liveItem.id}/seasons`)).statusCode).toBe(404);
});

test('unknown item returns 404 NOT_FOUND', async () => {
  const res = await get('/api/items/987654');
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  expect((await get('/api/items/987654/seasons')).statusCode).toBe(404);
});

test('item responses contain no provider URLs', async () => {
  const [cat] = (await get(`/api/providers/${providerId}/categories?kind=movie`)).json();
  const page = await get(`/api/categories/${cat.id}/items`);
  const single = await get(`/api/items/${page.json().items[0].id}`);
  for (const res of [page, single]) {
    const stripped = res.body.replace(/"logoUrl":"[^"]*"/g, '');
    expect(stripped).not.toContain('http');
    expect(stripped).not.toContain(fake.url);
    expect(res.body).not.toContain('remoteId');
    expect(res.body).not.toContain('containerExt');
  }
});

test('the series cache resolves episodes for stream building', async () => {
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: 'x' });
  const catalogue = createCatalogueRepo(db);
  const id = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(id), providerId: id });
  const series = catalogue.listItems(catalogue.listCategories(id, 'series')[0]!.id, null, 10)!.items[0]!;
  const cache = createSeriesInfoCache({ providers, catalogue });
  expect(await cache.getEpisode(series.id, '201')).toMatchObject({ remoteId: '201', containerExt: expect.any(String) });
  expect(await cache.getEpisode(series.id, 'nope')).toBeUndefined();
  expect(catalogue.getItem(series.id)).toMatchObject({ remoteId: '10' });
});
