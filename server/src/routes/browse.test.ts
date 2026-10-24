import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { BrowseView } from '@tv/shared';
import { startBrowseApp } from '../testing/browseApp.ts';
import { browseCatalogue } from '../testing/browseCatalogue.ts';

let h: Awaited<ReturnType<typeof startBrowseApp>>;
beforeAll(async () => {
  h = await startBrowseApp(browseCatalogue());
});
afterAll(() => h.close());
beforeEach(() => {
  h.db.exec('DELETE FROM category_rules; DELETE FROM curation_state; DELETE FROM pins; DELETE FROM favourites; DELETE FROM history; DELETE FROM positions');
});

const USER = 1;
const itemId = (name: string) => h.db.prepare('SELECT id FROM items WHERE name = ?').pluck().get(name) as number;
const categoryId = (name: string) => h.db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
const browse = async (kind: string) => {
  const res = await h.app.inject(`/api/me/browse/${kind}`);
  expect(res.statusCode).toBe(200);
  return res.json() as BrowseView;
};

test('browse returns only visible categories in provider order, with pinned ones listed in both places', async () => {
  h.curation.save(h.providerId, 'live', { tags: { UK: true, US: false }, categories: {} }, null);
  h.personal.pin(USER, categoryId('UK| News'));
  h.personal.pin(USER, categoryId('US| Sports')); // hidden, so it does not appear
  const view = await browse('live');
  expect(view.providerId).toBe(h.providerId);
  expect(view.kind).toBe('live');
  expect(view.categories).toEqual([
    { id: categoryId('UK| Sports'), displayName: 'Sports', itemCount: 1, pinned: false },
    { id: categoryId('UK| News'), displayName: 'News', itemCount: 1, pinned: true },
  ]);
  expect(view.pinned).toEqual([view.categories[1]]);
  expect(view.newCategories).toBe(0);
});

test('browse rows resolve personal ids to items and skip ones pruned from the catalogue', async () => {
  const bbc = itemId('UK| BBC News');
  const cafe = itemId('Café Plus');
  h.personal.addFavourite(USER, bbc);
  h.personal.addFavourite(USER, cafe);
  h.personal.recordPlay(USER, bbc, null);
  h.personal.recordPlay(USER, cafe, null);
  h.db.prepare('DELETE FROM item_categories WHERE item_id = ?').run(cafe);
  h.db.prepare('DELETE FROM items WHERE id = ?').run(cafe);
  const view = await browse('live');
  expect(view.favourites.map((i) => i.id)).toEqual([bbc]);
  expect(view.recent.map((i) => [i.id, i.favourite])).toEqual([[bbc, true]]);
});

test('continue watching names the episode and survives a missing series info', async () => {
  const movie = itemId('|EN| Sporting Chance');
  const series = itemId('|EN| Sport Series');
  h.personal.savePosition(USER, { itemId: movie, positionSec: 60, durationSec: 600 });
  h.personal.savePosition(USER, { itemId: series, episodeRemoteId: '201', positionSec: 100, durationSec: 1000 });
  const movies = await browse('movie');
  expect(movies.continueWatching).toMatchObject([
    { item: { id: movie, displayName: 'Sporting Chance' }, episodeRemoteId: null, episodeLabel: null, positionSec: 60, durationSec: 600 },
  ]);
  const shows = await browse('series');
  expect(shows.continueWatching).toMatchObject([
    { item: { id: series }, episodeRemoteId: '201', episodeLabel: 'S2 E3', positionSec: 100, durationSec: 1000 },
  ]);

  const original = h.seriesInfo.getSeasons;
  h.seriesInfo.getSeasons = () => Promise.reject(new Error('provider down'));
  try {
    const degraded = await browse('series');
    expect(degraded.continueWatching).toMatchObject([{ episodeRemoteId: '201', episodeLabel: null }]);
  } finally {
    h.seriesInfo.getSeasons = original;
  }
});

test('unknown kinds are rejected', async () => {
  expect((await h.app.inject('/api/me/browse/bogus')).statusCode).toBe(400);
});

test('with no provider the lists are empty', async () => {
  const empty = await startBrowseApp({
    live: { categories: [], items: [] },
    movie: { categories: [], items: [] },
    series: { categories: [], items: [] },
    episodes: {},
  });
  try {
    empty.db.exec('DELETE FROM providers');
    const res = await empty.app.inject('/api/me/browse/live');
    expect(res.json()).toEqual({
      providerId: null, kind: 'live', categories: [], pinned: [], recent: [], favourites: [], continueWatching: [], newCategories: 0,
    });
  } finally {
    await empty.close();
  }
});

test('category items carry displayName and favourite', async () => {
  const sky = itemId('UK| Sky Sports 1');
  h.personal.addFavourite(USER, sky);
  const page = (await h.app.inject(`/api/categories/${categoryId('UK| Sports')}/items`)).json();
  expect(page.items).toMatchObject([{ id: sky, name: 'UK| Sky Sports 1', displayName: 'UK| Sky Sports 1', favourite: true }]);
  h.curation.save(h.providerId, 'live', { tags: { UK: true, US: false }, categories: {} }, null);
  const single = (await h.app.inject(`/api/items/${itemId('UK| BBC News')}`)).json();
  expect(single).toMatchObject({ displayName: 'BBC News', favourite: false });
});
