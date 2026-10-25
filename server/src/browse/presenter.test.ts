import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { startBrowseApp } from '../testing/browseApp.ts';
import { browseCatalogue } from '../testing/browseCatalogue.ts';
import { createGuideQueries } from '../guide/query.ts';
import type { GuideQueries } from '../guide/query.ts';
import { createGuideStore } from '../guide/store.ts';
import { FAVOURITES_LIMIT, createPresenter } from './presenter.ts';

let h: Awaited<ReturnType<typeof startBrowseApp>>;
beforeAll(async () => {
  h = await startBrowseApp(browseCatalogue());
});
afterAll(() => h.close());
beforeEach(() => h.db.exec('DELETE FROM category_rules; DELETE FROM curation_state; DELETE FROM favourites'));

const itemId = (name: string) => h.db.prepare('SELECT id FROM items WHERE name = ?').pluck().get(name) as number;

test('items carry their kind\'s display name and the favourite flag', () => {
  const presenter = createPresenter(h);
  // Two live tag groups are visible, so live names stay whole until one is switched off.
  h.personal.addFavourite(1, itemId('UK| BBC News'));
  const stored = ['UK| BBC News', '|EN| Sporting Chance'].map((n) => h.catalogue.getItem(itemId(n))!);
  expect(presenter.items(stored, 1).map((i) => [i.displayName, i.favourite])).toEqual([
    ['UK| BBC News', true],
    ['Sporting Chance', false],
  ]);

  h.curation.save(h.providerId, 'live', { tags: { UK: true, US: false }, categories: {} }, null);
  expect(presenter.items(stored.slice(0, 1), 1)[0]!.displayName).toBe('BBC News');
});

test('presented items drop provider-internal fields', () => {
  const presenter = createPresenter(h);
  const [out] = presenter.items([h.catalogue.getItem(itemId('UK| BBC News'))!], 1);
  expect(out).not.toHaveProperty('remoteId');
  expect(out).not.toHaveProperty('containerExt');
});

test('live items carry now; movies don\'t', async () => {
  const NOW_MS = 5_000_000_000;
  const nowSec = NOW_MS / 1000;
  const bbc = itemId('UK| BBC News');
  const sky = itemId('UK| Sky Sports 1');
  const movie = itemId('|EN| Sporting Chance');
  const store = createGuideStore(h.db);
  const g = store.beginGeneration(h.providerId, 0);
  store.insertProgrammes(h.providerId, g, [
    { channelKey: 'bbc', start: nowSec - 60, stop: nowSec + 60, title: 'News at Ten', subtitle: null, description: null, category: null },
  ]);
  store.commitGeneration(h.providerId, g, { fetchedAt: 0, source: 'xmltv' });
  h.db.prepare("INSERT INTO guide_links (item_id, provider_id, channel_key, method) VALUES (?, ?, 'bbc', 'id')").run(bbc, h.providerId);
  try {
    const presenter = createPresenter({ ...h, guide: createGuideQueries(h.db), now: () => NOW_MS });
    const stored = [bbc, sky, movie].map((id) => h.catalogue.getItem(id)!);
    const [a, b, c] = presenter.items(stored, 1);
    expect(a!.now).toEqual({ title: 'News at Ten', startSec: nowSec - 60, stopSec: nowSec + 60 });
    expect(b!.now).toBeNull();
    expect(c).not.toHaveProperty('now');
    h.personal.addFavourite(1, bbc);
    const view = await presenter.browse(1, h.providerId, 'live');
    expect(view.favourites.map((i) => i.now?.title)).toEqual(['News at Ten']);
  } finally {
    h.db.exec('DELETE FROM guide_links; DELETE FROM programmes; DELETE FROM guide_state');
  }
});

test('item names under another tag pattern than their categories lose the single visible tag', () => {
  const presenter = createPresenter(h);
  const id = itemId('|EN| Bukowski Days');
  h.db.prepare('UPDATE items SET name = ? WHERE id = ?').run('EN - Title', id);
  try {
    expect(presenter.items([h.catalogue.getItem(id)!], 1)[0]!.displayName).toBe('Title');
  } finally {
    h.db.prepare('UPDATE items SET name = ? WHERE id = ?').run('|EN| Bukowski Days', id);
  }
});

test('a presented batch makes one nowFor call', () => {
  const calls: number[][] = [];
  const guide = { nowFor: (_p: number, ids: number[]) => (calls.push(ids), new Map()) } as unknown as GuideQueries;
  const presenter = createPresenter({ ...h, guide, now: () => 0 });
  const stored = ['UK| BBC News', 'UK| Sky Sports 1', '|EN| Sporting Chance'].map((n) => h.catalogue.getItem(itemId(n))!);
  presenter.items(stored, 1);
  expect(calls).toEqual([[itemId('UK| BBC News'), itemId('UK| Sky Sports 1')]]);
});

test('favouriteCount counts every favourite, though the favourites list stops at its limit', async () => {
  const presenter = createPresenter(h);
  const insert = h.db.prepare("INSERT INTO items (provider_id, kind, remote_id, name, seen_at) VALUES (?, 'live', ?, ?, 0)");
  const ids = Array.from({ length: FAVOURITES_LIMIT + 1 }, (_, i) => Number(insert.run(h.providerId, `fav-${i}`, `Fav ${i}`).lastInsertRowid));
  try {
    for (const id of ids) h.personal.addFavourite(1, id);
    const view = await presenter.browse(1, h.providerId, 'live');
    expect(view.favourites).toHaveLength(FAVOURITES_LIMIT);
    expect(view.favouriteCount).toBe(FAVOURITES_LIMIT + 1);
    expect((await presenter.browse(1, h.providerId, 'movie')).favouriteCount).toBe(0);
  } finally {
    h.db.exec("DELETE FROM items WHERE remote_id LIKE 'fav-%'");
  }
});
