import { expect, test } from 'vitest';
import type { BrowseView, CatalogItem, ContinueItem, Kind } from '@tv/shared';
import { browseSections, hueFor, initials, newCategoriesBanner, posterRowHeight } from './browseModel.ts';

const item = (id: number, kind: Kind = 'live'): CatalogItem => ({
  id, providerId: 1, kind, name: `n${id}`, displayName: `n${id}`, logoUrl: null,
  catchupDays: null, year: null, rating: null, favourite: false,
});
const cont: ContinueItem = { item: item(9, 'movie'), episodeRemoteId: null, episodeLabel: null, positionSec: 5, durationSec: 100 };
const cat = (id: number, pinned = false) => ({ id, displayName: `c${id}`, itemCount: 1, pinned });

const full = (kind: Kind): BrowseView => ({
  providerId: 1, kind, categories: [cat(1), cat(2, true)], pinned: [cat(2, true)],
  recent: [item(1)], favourites: [item(2)], continueWatching: [cont], newCategories: 0,
});
const keys = (v: BrowseView) => browseSections(v).map((s) => s.key);

test('live order: recently watched, favourite channels, pinned, all categories', () => {
  expect(browseSections(full('live'))).toEqual([
    { key: 'recent', title: 'Recently watched', kind: 'items' },
    { key: 'favourites', title: 'Favourite channels', kind: 'items' },
    { key: 'pinned', title: 'Pinned', kind: 'categories' },
    { key: 'all', title: 'All categories', kind: 'categories' },
  ]);
});

test('movies and series order: continue watching, favourites, pinned, all categories', () => {
  for (const kind of ['movie', 'series'] as const) {
    expect(browseSections(full(kind))).toEqual([
      { key: 'continue', title: 'Continue watching', kind: 'continue' },
      { key: 'favourites', title: 'Favourites', kind: 'items' },
      { key: 'pinned', title: 'Pinned', kind: 'categories' },
      { key: 'all', title: 'All categories', kind: 'categories' },
    ]);
  }
});

test('empty sections are omitted', () => {
  const v = { ...full('live'), recent: [], pinned: [], favourites: [] };
  expect(keys(v)).toEqual(['all']);
  expect(keys({ ...full('movie'), continueWatching: [], categories: [] })).toEqual(['favourites', 'pinned']);
});

test('poster rows fit a 2:3 poster plus caption', () => {
  expect(posterRowHeight(360)).toBe(Math.ceil(108 * 1.5) + 46 + 12);
  expect(posterRowHeight(0)).toBe(46 + 12);
});

test('placeholder tiles: initials from the first two words and a stable hue', () => {
  expect(initials('BBC One HD')).toBe('BO');
  expect(initials('sky')).toBe('S');
  expect(initials('  | ')).toBe('?');
  expect(hueFor('BBC One')).toBe(hueFor('BBC One'));
  expect(hueFor('BBC One')).toBeLessThan(360);
});

test('the banner appears only when there are new categories', () => {
  expect(newCategoriesBanner({ ...full('movie'), newCategories: 3 })).toEqual({
    text: '3 new categories — review',
    href: '/settings/categories?kind=movie',
  });
  expect(newCategoriesBanner(full('live'))).toBeNull();
});
