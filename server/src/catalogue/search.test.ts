import { afterAll, beforeAll, expect, test } from 'vitest';
import { startBrowseApp } from '../testing/browseApp.ts';
import { browseCatalogue } from '../testing/browseCatalogue.ts';
import { createSearch } from './search.ts';
import type { Search } from './search.ts';

let h: Awaited<ReturnType<typeof startBrowseApp>>;
let search: Search;

beforeAll(async () => {
  h = await startBrowseApp(browseCatalogue());
  search = createSearch(h.db);
});
afterAll(() => h.close());

const all = () => new Set(h.db.prepare('SELECT id FROM categories').pluck().all() as number[]);
const names = (q: string, kind: 'live' | 'movie' | 'series', visible = all(), limit = 20) =>
  search.items(h.providerId, kind, q, visible, limit).map((i) => i.name);

test('substring match is case- and accent-insensitive', () => {
  expect(names('SPOR', 'live').sort()).toEqual(['UK| Sky Sports 1', 'US| ESPN Sport']);
  expect(names('cafe', 'live')).toEqual(['Café Plus']);
});

test('items whose categories are all hidden are ignored', () => {
  const us = h.db.prepare("SELECT id FROM categories WHERE name = 'US| Sports'").pluck().get() as number;
  const visible = new Set([...all()].filter((id) => id !== us));
  expect(names('spor', 'live', visible)).toEqual(['UK| Sky Sports 1']);
  expect(names('spor', 'live', new Set())).toEqual([]);
});

test('below 3 characters it is a prefix match, with LIKE wildcards inert', () => {
  expect(names('uk', 'live').sort()).toEqual(['UK| BBC News', 'UK| Sky Sports 1']);
  expect(names('uk', 'movie')).toEqual([]);
  expect(names('%', 'live')).toEqual([]);
  expect(names('_k', 'live')).toEqual([]);
  expect(names('\\', 'live')).toEqual([]);
});

test('the limit is applied in the query', () => {
  expect(names('spor', 'live', all(), 1)).toHaveLength(1);
});
