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
const names = (q: string, kind: 'live' | 'movie' | 'series', visible: Set<number> | 'all' = all(), limit = 20) =>
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

test("a category the curation hides keeps its items out, though the category's group is shown", () => {
  h.curation.save(h.providerId, 'live', { tags: { UK: true, US: true }, categories: { '3': false, '4': true } }, null);
  try {
    const { visibleIds, allVisible } = h.curation.resolution(h.providerId, 'live', 1);
    expect(allVisible).toBe(false);
    expect(names('spor', 'live', visibleIds)).toEqual(['UK| Sky Sports 1']);
    expect(names('us', 'live', visibleIds)).toEqual(['US| Late Show']);
  } finally {
    h.db.prepare('DELETE FROM category_rules').run();
    h.db.prepare('DELETE FROM curation_state').run();
  }
});

test("with every category visible, 'all' finds the same rows in the same order as listing every category", () => {
  for (const kind of ['live', 'movie', 'series'] as const) {
    const { visibleIds, allVisible } = h.curation.resolution(h.providerId, kind, 1);
    expect(allVisible).toBe(true);
    for (const q of ['s', 'sp', 'spor', 'en|', 'ca', 'zzz']) {
      expect(names(q, kind, 'all'), `${kind} ${q}`).toEqual(names(q, kind, visibleIds));
    }
  }
  expect(names('spor', 'live', 'all')).toHaveLength(2);
});
