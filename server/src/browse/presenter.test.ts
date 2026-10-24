import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { startBrowseApp } from '../testing/browseApp.ts';
import { browseCatalogue } from '../testing/browseCatalogue.ts';
import { createPresenter } from './presenter.ts';

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
