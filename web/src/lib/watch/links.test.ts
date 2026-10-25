import { expect, test } from 'vitest';
import { filterCategory, watchHref } from './links.ts';
import { parseWatchParams } from './params.ts';

test('category and catch-up are encoded; favourites passes through', () => {
  expect(watchHref(7)).toBe('/watch?item=7');
  expect(watchHref(7, { category: '3' })).toBe('/watch?item=7&cat=3');
  expect(watchHref(7, { category: null })).toBe('/watch?item=7');
  expect(watchHref(7, { category: 'favourites' })).toBe('/watch?item=7&cat=favourites');
  expect(watchHref(11, { episode: 'a b&c' })).toBe('/watch?item=11&episode=a%20b%26c');
  const catchup = watchHref(7, { category: '3', catchup: { startSec: 1000, stopSec: 2000, title: 'Late & Live' } });
  expect(catchup).toBe('/watch?item=7&from=1000&to=2000&title=Late%20%26%20Live&cat=3');
  // What the watch page reads back.
  expect(parseWatchParams(new URL(catchup, 'http://localhost'))).toMatchObject({
    itemId: 7,
    catchup: { startSec: 1000, stopSec: 2000, title: 'Late & Live' },
    category: '3',
  });

  expect(filterCategory('category:3')).toBe('3');
  expect(filterCategory('favourites')).toBe('favourites');
  expect(filterCategory('all')).toBeNull();
});
