import { expect, test } from 'vitest';
import { parseWatchParams } from './params.ts';

const parse = (query: string) => parseWatchParams(new URL(`http://localhost/watch?${query}`));

test('item, episode and t', () => {
  expect(parse('item=7&episode=e1&t=600')).toEqual({ itemId: 7, episode: 'e1', t: 600, catchup: null, category: null });
  expect(parse('item=7')).toMatchObject({ itemId: 7, episode: null, t: 0 });
  expect(parse('item=7&episode=').episode).toBeNull();
});

test.each([
  ['abc', 0],
  ['-5', 0],
  ['Infinity', 0],
  ['0', 0],
  ['12.5', 12.5],
])('t=%s starts at %d', (t, expected) => {
  expect(parse(`item=7&t=${t}`).t).toBe(expected);
});

test.each([
  ['from=3600&to=7200&title=News', { startSec: 3600, stopSec: 7200, title: 'News' }],
  ['from=3600&to=7200&title=%20News%20', { startSec: 3600, stopSec: 7200, title: 'News' }],
  ['from=3600&to=7200&title=%20', { startSec: 3600, stopSec: 7200, title: '' }],
  ['from=3600&to=7200', { startSec: 3600, stopSec: 7200, title: '' }],
  ['from=7200&to=3600', null],
  ['from=3600&to=3600', null],
  ['from=0&to=7200', null],
  ['from=abc&to=7200', null],
  ['from=03600&to=7200', null],
  ['from=-3600&to=7200', null],
  ['from=3600.5&to=7200', null],
  ['from=3600', null],
  ['to=7200', null],
  ['from=123456789012345678901234567890&to=999999999999999999999999999999', null],
])('catch-up %s', (query, expected) => {
  expect(parse(`item=7&${query}`).catchup).toEqual(expected);
});

test.each([
  ['cat=12', '12'],
  ['cat=favourites', 'favourites'],
  ['cat=0', null],
  ['cat=abc', null],
  ['cat=category%3A12', null],
  ['cat=', null],
  ['cat=123456789012345678901234567890', null],
  ['', null],
])('category %s', (query, expected) => {
  expect(parse(`item=7&${query}`).category).toBe(expected);
});
