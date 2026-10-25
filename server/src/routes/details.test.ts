import { afterAll, beforeAll, expect, test } from 'vitest';
import Fastify from 'fastify';
import type { ItemDetails, WatchContext } from '@tv/shared';
import { richCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { ProviderError } from '../providers/errors.ts';
import { startBrowseApp } from '../testing/browseApp.ts';
import { PNG } from '../testing/imageServer.ts';
import { detailsRoutes } from './details.ts';

let h: Awaited<ReturnType<typeof startBrowseApp>>;
let seriesId: number;
let movieId: number;

const idOf = (kind: string, remoteId: string) =>
  h.db.prepare('SELECT id FROM items WHERE kind = ? AND remote_id = ?').pluck().get(kind, remoteId) as number;
const details = async (id: number) => h.app.inject(`/api/items/${id}/details`);

beforeAll(async () => {
  h = await startBrowseApp(richCatalogue());
  seriesId = idOf('series', '11');
  movieId = idOf('movie', '5');
});
afterAll(() => h.close());

test('series details', async () => {
  const res = await details(seriesId);
  expect(res.statusCode).toBe(200);
  const body = res.json<Extract<ItemDetails, { kind: 'series' }>>();
  expect(body).toMatchObject({
    kind: 'series',
    plot: 'A chef takes over a busy kitchen.',
    genre: 'Drama / Comedy',
    cast: 'Ann Lee, Bo Chan',
    director: 'Cy Dee',
    year: 2022,
    rating: '8',
    posterUrl: `/api/art/${seriesId}/poster`,
    backdropUrl: `/api/art/${seriesId}/backdrop`,
  });
  expect(body.seasons.map((s) => s.season)).toEqual([0, 1, 2]);
  expect(body.seasons[0]).toMatchObject({ name: 'Specials', coverUrl: null });
  expect(body.seasons[1]!.coverUrl).toBe(`/api/art/${seriesId}/season-1`);
  expect(body.seasons[1]!.episodes.map((e) => e.title)).toEqual(['Pilot', 'Rush']);
  expect(body.seasons[1]!.episodes[0]).toMatchObject({
    remoteId: '111',
    quality: 'HD',
    imageUrl: `/api/art/${seriesId}/episode-111`,
  });
});

test('movie details', async () => {
  const body = (await details(movieId)).json<ItemDetails>();
  expect(body).toMatchObject({
    kind: 'movie',
    plot: 'Two languages, two subtitles.',
    durationSec: 30,
    year: 2021,
    posterUrl: `/api/art/${movieId}/poster`,
    backdropUrl: `/api/art/${movieId}/backdrop`,
  });
});

test('no provider URL appears anywhere in the body', async () => {
  for (const id of [seriesId, movieId]) {
    const text = (await details(id)).body;
    expect(text).not.toContain(h.fake.url);
    expect(text).not.toContain('127.0.0.1');
  }
});

test('details are 404 for a live channel and an unknown item', async () => {
  const live = h.db.prepare("SELECT id FROM items WHERE kind = 'live' LIMIT 1").pluck().get() as number;
  expect((await details(live)).statusCode).toBe(404);
  expect((await details(987654)).statusCode).toBe(404);
});

test('art is served from the cache with image headers', async () => {
  for (const slot of ['poster', 'backdrop', 'season-1', 'episode-111']) {
    const res = await h.app.inject(`/api/art/${seriesId}/${slot}`);
    expect(res.statusCode, slot).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=604800');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload).toEqual(PNG);
  }
  expect((await h.app.inject(`/api/art/${movieId}/poster`)).statusCode).toBe(200);
});

test('an unknown slot or an item without art is 404', async () => {
  const missing = [
    `/api/art/${seriesId}/nonsense`,
    `/api/art/${seriesId}/season-2`, // no cover in the provider's seasons list
    `/api/art/${seriesId}/season-1000`,
    `/api/art/${seriesId}/episode-nope`,
    `/api/art/${seriesId}/..%2Fx`,
    `/api/art/${movieId}/season-1`,
    `/api/art/${movieId}/episode-111`,
    '/api/art/987654/poster',
  ];
  for (const url of missing) {
    const res = await h.app.inject(url);
    expect(res.statusCode, url).toBe(404);
  }
  const live = h.db.prepare("SELECT id FROM items WHERE kind = 'live' LIMIT 1").pluck().get() as number;
  expect((await h.app.inject(`/api/art/${live}/poster`)).statusCode).toBe(404);
});

test('context prefers the given visible category and falls back to the first visible one', async () => {
  const live = h.db.prepare("SELECT id FROM items WHERE kind = 'live' ORDER BY id LIMIT 1").pluck().get() as number;
  const cats = h.db
    .prepare("SELECT id, name FROM categories WHERE kind = 'live' ORDER BY position, id")
    .all() as { id: number; name: string }[];
  expect(cats.length).toBeGreaterThanOrEqual(2);
  const [a, b] = cats as [(typeof cats)[0], (typeof cats)[0]];
  h.db.prepare('DELETE FROM item_categories WHERE item_id = ?').run(live);
  h.db.prepare('INSERT INTO item_categories (category_id, item_id, position) VALUES (?, ?, 0), (?, ?, 0)').run(a.id, live, b.id, live);
  const ctx = async (query = '') => (await h.app.inject(`/api/items/${live}/context${query}`)).json<WatchContext>();

  expect(await ctx(`?category=${b.id}`)).toEqual({ categoryId: b.id, label: b.name });
  expect(await ctx()).toEqual({ categoryId: a.id, label: a.name }); // first by position
  expect(await ctx('?category=999999')).toEqual({ categoryId: a.id, label: a.name }); // not one of its categories
  expect(await ctx('?category=favourites')).toEqual({ categoryId: null, label: 'Favourites' });

  expect(h.curation.hideCategory(a.id, null)).toBe(true);
  expect(await ctx(`?category=${a.id}`)).toEqual({ categoryId: b.id, label: b.name }); // hidden: next visible
  expect(h.curation.hideCategory(b.id, null)).toBe(true);
  expect(await ctx(`?category=${b.id}`)).toEqual({ categoryId: null, label: null });

  expect((await h.app.inject(`/api/items/${seriesId}/context`)).statusCode).toBe(404);
});

test('a provider failure is a 502 with its code', async () => {
  const failing = Fastify();
  await failing.register(
    detailsRoutes({
      db: h.db,
      catalogue: h.catalogue,
      curation: h.curation,
      art: { get: async () => null, sweep: async () => ({ deleted: 0, bytes: 0 }), start() {}, stop() {} },
      seriesInfo: {
        ...h.seriesInfo,
        getDetails: async () => {
          throw new ProviderError('PROVIDER_UNREACHABLE', 'provider is down');
        },
      },
      vodInfo: {
        getDetails: async () => {
          throw new ProviderError('PROVIDER_AUTH_FAILED', 'bad login');
        },
      },
    }),
    { prefix: '/api' },
  );
  const series = await failing.inject(`/api/items/${seriesId}/details`);
  expect(series.statusCode).toBe(502);
  expect(series.json()).toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
  const movie = await failing.inject(`/api/items/${movieId}/details`);
  expect(movie.statusCode).toBe(502);
  expect(movie.json()).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  expect((await failing.inject(`/api/art/${seriesId}/poster`)).statusCode).toBe(502);
  await failing.close();
});
