import { afterEach, expect, test, vi } from 'vitest';
import { rememberSubtitleLanguage, subtitleLanguage } from './trackPrefs.ts';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test('subtitle language is remembered and survives a throwing localStorage', () => {
  expect(subtitleLanguage()).toBeNull();
  rememberSubtitleLanguage('nl');
  expect(localStorage.getItem('tv.subtitleLang')).toBe('nl');
  expect(subtitleLanguage()).toBe('nl');
  rememberSubtitleLanguage(null);
  expect(subtitleLanguage()).toBeNull();

  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
  expect(subtitleLanguage()).toBeNull();
  expect(() => rememberSubtitleLanguage('en')).not.toThrow();
  expect(() => rememberSubtitleLanguage(null)).not.toThrow();
});
