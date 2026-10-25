import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { richCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { createCatalogueRepo } from './repo.ts';
import { syncCatalogue } from './sync.ts';
import { createVodInfoCache } from './vodInfo.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
let fake: FakeXtream;
beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: richCatalogue() });
});
afterAll(async () => {
  await fake?.close();
});

async function setup() {
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: 'x' });
  const catalogue = createCatalogueRepo(db);
  const providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
  const movie = (remoteId: string) =>
    db.prepare("SELECT id FROM items WHERE provider_id = ? AND kind = 'movie' AND remote_id = ?").get(providerId, remoteId) as { id: number };
  return { providers, catalogue, providerId, movie };
}

/** providers whose client counts getVodInfo calls; `fail` makes the first n of them throw. */
function counting(real: ReturnType<typeof createProviderService>, providerId: number, fail = 0) {
  const counter = { calls: 0 };
  const client = real.clientFor(providerId);
  const providers = {
    ...real,
    clientFor: () => ({
      ...client,
      getVodInfo: async (rid: string) => {
        if (++counter.calls <= fail) throw new Error('boom');
        return client.getVodInfo(rid);
      },
    }),
  } as typeof real;
  return { providers, counter };
}

test('movie 5 details', async () => {
  const { providers, catalogue, movie } = await setup();
  const cache = createVodInfoCache({ catalogue, providers });
  expect(await cache.getDetails(movie('5').id)).toEqual({
    plot: 'Two languages, two subtitles.',
    genre: 'Test',
    cast: 'A, B',
    director: 'C',
    releaseDate: '2021-01-01',
    rating: '7',
    coverUrl: `${fake.url}/images/poster.png`,
    backdropUrls: [`${fake.url}/images/backdrop.png`],
    durationSec: 30,
  });
});

test('a movie the provider knows nothing about gives nulls, and a missing item gives null', async () => {
  const { providers, catalogue, movie } = await setup();
  const cache = createVodInfoCache({ catalogue, providers });
  expect(await cache.getDetails(movie('1').id)).toEqual({
    plot: null, genre: null, cast: null, director: null, releaseDate: null, rating: null, coverUrl: null, backdropUrls: [], durationSec: null,
  });
  expect(await cache.getDetails(999_999)).toBeNull();
});

test('a provider failure is not cached', async () => {
  const { providers, catalogue, providerId, movie } = await setup();
  const { providers: stub, counter } = counting(providers, providerId, 1);
  const cache = createVodInfoCache({ catalogue, providers: stub });
  const id = movie('5').id;
  await expect(cache.getDetails(id)).rejects.toThrow('boom');
  expect((await cache.getDetails(id))?.plot).toBe('Two languages, two subtitles.');
  await cache.getDetails(id);
  expect(counter.calls).toBe(2);
});

test('entries expire after an hour and the cache evicts the oldest past its cap', async () => {
  const { providers, catalogue, providerId, movie } = await setup();
  const { providers: stub, counter } = counting(providers, providerId);
  let t = 1_000_000;
  const cache = createVodInfoCache({ catalogue, providers: stub, now: () => t, maxEntries: 2 });
  const five = movie('5').id;
  await cache.getDetails(five);
  t += 3_599_000;
  await cache.getDetails(five);
  expect(counter.calls).toBe(1);
  t += 2_000;
  await cache.getDetails(five);
  expect(counter.calls).toBe(2);

  await cache.getDetails(movie('1').id);
  await cache.getDetails(movie('2').id); // evicts movie 5, the oldest
  expect(counter.calls).toBe(4);
  await cache.getDetails(five);
  expect(counter.calls).toBe(5);
});
