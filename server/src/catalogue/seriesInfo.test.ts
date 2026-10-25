import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { richCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import type { SeriesInfo } from '../providers/xtream/client.ts';
import { createCatalogueRepo } from './repo.ts';
import { createSeriesInfoCache, SERIES_CACHE_MAX, SERIES_TTL_MS } from './seriesInfo.ts';
import { syncCatalogue } from './sync.ts';

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
  const series = (remoteId: string) =>
    db.prepare("SELECT id FROM items WHERE provider_id = ? AND kind = 'series' AND remote_id = ?").get(providerId, remoteId) as { id: number };
  return { providers, catalogue, providerId, series };
}

const emptyMeta = { name: null, plot: null, genre: null, cast: null, director: null, releaseDate: null, rating: null, coverUrl: null, backdropUrls: [] };
const ep = (remoteId: string, episodeNum: number, title: string) => ({
  remoteId, title, episodeNum, containerExt: 'mkv', durationSec: 60, imageUrl: null, airDate: null, width: null, height: null,
});
const infoOf = (episodes: ReturnType<typeof ep>[]): SeriesInfo => ({ meta: emptyMeta, seasonMeta: {}, seasons: [{ season: 1, episodes }] });

/** providers whose client returns `info()` for every series and counts the calls. */
function stubbed(real: ReturnType<typeof createProviderService>, providerId: number, info: () => Promise<SeriesInfo>) {
  const counter = { calls: 0 };
  const client = real.clientFor(providerId);
  const providers = {
    ...real,
    clientFor: () => ({ ...client, getSeriesInfo: () => (counter.calls++, info()) }),
  } as typeof real;
  return { providers, counter };
}

test('seasons come from episodes when the seasons list is incomplete', async () => {
  const { providers, catalogue, series } = await setup();
  const cache = createSeriesInfoCache({ providers, catalogue });
  const details = await cache.getDetails(series('11').id);
  expect(details.seasons.map((s) => [s.season, s.name])).toEqual([[0, 'Specials'], [1, 'Season 1'], [2, 'Season 2']]);
  expect(details.seasonMeta[1]).toEqual({ name: 'Season 1', coverUrl: `${fake.url}/images/s1.png` });
  expect(details.meta).toMatchObject({ name: 'EN - THE KITCHEN (2022)', plot: 'A chef takes over a busy kitchen.', coverUrl: `${fake.url}/images/poster.png` });
});

test('titles are cleaned', async () => {
  const { providers, catalogue, series } = await setup();
  const cache = createSeriesInfoCache({ providers, catalogue });
  const id = series('11').id;
  const seasons = await cache.getSeasons(id);
  expect(seasons.map((s) => s.episodes.map((e) => e.title))).toEqual([['Behind the scenes'], ['Pilot', 'Rush'], ['Review']]);
  const details = await cache.getDetails(id);
  expect(details.seasons[1]!.episodes[0]).toMatchObject({
    remoteId: '111', title: 'Pilot', imageUrl: `${fake.url}/images/ep111.png`, airDate: '2022-06-23', quality: 'HD', durationSec: 30,
  });
});

test('duplicate episode numbers keep both, ordered by number then id', async () => {
  const { providers, catalogue, providerId, series } = await setup();
  const info = infoOf([ep('30', 2, 'S01E02 - B'), ep('20', 1, 'S01E01 - Second'), ep('9', 1, 'S01E01 - First'), ep('40', 3, 'S01E03')]);
  const { providers: stub } = stubbed(providers, providerId, async () => info);
  const cache = createSeriesInfoCache({ providers: stub, catalogue });
  const [season] = await cache.getSeasons(series('10').id);
  expect(season!.episodes.map((e) => [e.remoteId, e.title])).toEqual([['9', 'First'], ['20', 'Second'], ['30', 'B'], ['40', 'Episode 3']]);
});

test('entries expire after an hour and the cache keeps 200', async () => {
  expect(SERIES_TTL_MS).toBe(3_600_000);
  expect(SERIES_CACHE_MAX).toBe(200);
  const { providers, catalogue, providerId, series } = await setup();
  const { providers: stub, counter } = stubbed(providers, providerId, async () => infoOf([ep('1', 1, 'x')]));
  let t = 5_000_000;
  const cache = createSeriesInfoCache({ providers: stub, catalogue, now: () => t, maxEntries: 2 });
  const a = series('10').id;
  await cache.getSeasons(a);
  t += SERIES_TTL_MS - 1;
  await cache.getSeasons(a);
  expect(counter.calls).toBe(1);
  t += 2;
  await cache.getSeasons(a);
  expect(counter.calls).toBe(2);

  await cache.getSeasons(series('11').id);
  expect(counter.calls).toBe(3);
  await cache.getSeasons(series('11').id);
  expect(counter.calls).toBe(3);
});

test('past its cap the cache drops the oldest entry', async () => {
  const { providers, catalogue, providerId, series } = await setup();
  const { providers: stub, counter } = stubbed(providers, providerId, async () => infoOf([ep('1', 1, 'x')]));
  // Only two series exist, so a cap of 1 shows the eviction.
  const cache = createSeriesInfoCache({ providers: stub, catalogue, maxEntries: 1 });
  await cache.getSeasons(series('10').id);
  await cache.getSeasons(series('11').id); // evicts 10
  await cache.getSeasons(series('10').id);
  expect(counter.calls).toBe(3);
});

test('a failure is not cached', async () => {
  const { providers, catalogue, providerId, series } = await setup();
  let n = 0;
  const { providers: stub, counter } = stubbed(providers, providerId, async () => {
    if (++n === 1) throw new Error('boom');
    return infoOf([]);
  });
  const cache = createSeriesInfoCache({ providers: stub, catalogue });
  const id = series('10').id;
  await expect(cache.getSeasons(id)).rejects.toThrow('boom');
  expect(await cache.getSeasons(id)).toEqual([{ season: 1, episodes: [] }]);
  expect(counter.calls).toBe(2);
});

test('getEpisode still resolves container and position', async () => {
  const { providers, catalogue, series } = await setup();
  const cache = createSeriesInfoCache({ providers, catalogue });
  expect(await cache.getEpisode(series('11').id, '121')).toEqual({ remoteId: '121', containerExt: 'mkv', durationSec: 30, season: 2, episodeNum: 1 });
  expect(await cache.getEpisode(series('11').id, 'nope')).toBeUndefined();
});
