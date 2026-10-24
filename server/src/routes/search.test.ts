import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { SearchResults } from '@tv/shared';
import { startBrowseApp } from '../testing/browseApp.ts';
import { browseCatalogue } from '../testing/browseCatalogue.ts';

let h: Awaited<ReturnType<typeof startBrowseApp>>;
beforeAll(async () => {
  h = await startBrowseApp(browseCatalogue());
});
afterAll(() => h.close());
beforeEach(() => h.db.exec('DELETE FROM category_rules; DELETE FROM curation_state; DELETE FROM pins'));

const search = async (q: string, extra = '') => {
  const res = await h.app.inject(`/api/search?q=${encodeURIComponent(q)}${extra}`);
  expect(res.statusCode).toBe(200);
  return res.json() as SearchResults;
};

test('search finds substrings across kinds, case- and accent-insensitive', async () => {
  const res = await search('SPOR');
  expect(res.live.map((i) => i.name).sort()).toEqual(['UK| Sky Sports 1', 'US| ESPN Sport']);
  expect(res.movie.map((i) => i.displayName)).toEqual(['Sporting Chance']);
  expect(res.series.map((i) => i.displayName)).toEqual(['Sport Series']);
  expect(res.categories.map((c) => [c.kind, c.displayName]).sort()).toEqual([
    ['live', 'UK| Sports'],
    ['live', 'US| Sports'],
    ['series', 'Sport Stories'],
  ]);
  expect((await search('cafe')).live.map((i) => i.name)).toEqual(['Café Plus']);
});

test('search ignores items whose categories are all hidden', async () => {
  h.curation.save(h.providerId, 'live', { tags: { UK: true, US: false }, categories: {} }, null);
  const res = await search('spor');
  expect(res.live.map((i) => i.displayName)).toEqual(['Sky Sports 1']);
  expect(res.categories.filter((c) => c.kind === 'live').map((c) => c.displayName)).toEqual(['Sports']);
  expect((await search('cafe')).live).toEqual([]);
});

test('search uses a prefix match below 3 characters', async () => {
  const res = await search('uk');
  expect(res.live.map((i) => i.name).sort()).toEqual(['UK| BBC News', 'UK| Sky Sports 1']);
  expect(res.movie).toEqual([]); // Bukowski contains "uk" but does not start with it
});

test('limit defaults to 20, caps at 50 and bounds each kind', async () => {
  expect((await search('spor', '&limit=1')).live).toHaveLength(1);
  expect((await h.app.inject('/api/search?q=spor&limit=0')).statusCode).toBe(400);
  expect((await h.app.inject('/api/search?q=spor&limit=500')).statusCode).toBe(200);
});

test('search survives hostile input', async () => {
  for (const q of ['"', '*', '-x', 'NEAR(a b)', '(', 'a AND', '🙂', 'x'.repeat(200), '   ']) {
    const res = await h.app.inject(`/api/search?q=${encodeURIComponent(q)}`);
    expect(res.statusCode).toBe(200);
  }
  expect(await search('')).toEqual({ live: [], movie: [], series: [], categories: [] });
});
