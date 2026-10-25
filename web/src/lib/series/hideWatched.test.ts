import { afterEach, expect, test, vi } from 'vitest';
import { hideWatched, setHideWatched } from './hideWatched.ts';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test('survives a throwing localStorage', () => {
  expect(hideWatched()).toBe(false);
  setHideWatched(true);
  expect(localStorage.getItem('tv.hideWatched')).toBe('1');
  expect(hideWatched()).toBe(true);
  setHideWatched(false);
  expect(localStorage.getItem('tv.hideWatched')).toBeNull();
  expect(hideWatched()).toBe(false);

  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
  expect(hideWatched()).toBe(false);
  expect(() => setHideWatched(true)).not.toThrow();
  expect(() => setHideWatched(false)).not.toThrow();
});
