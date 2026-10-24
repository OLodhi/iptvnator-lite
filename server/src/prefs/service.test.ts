import { beforeEach, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createPrefsService } from './service.ts';
import type { PrefsService } from './service.ts';

let db: Db;
let prefs: PrefsService;

beforeEach(() => {
  db = openDb(':memory:');
  prefs = createPrefsService(db);
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 0)").run();
});

test('round-trips an object', () => {
  prefs.set(1, 'guide', { filter: 'all', hours: [1, 2] });
  expect(prefs.get(1, 'guide', null)).toEqual({ filter: 'all', hours: [1, 2] });
  prefs.set(1, 'guide', 'replaced');
  expect(prefs.get(1, 'guide', null)).toBe('replaced');
});

test('a missing key returns the fallback', () => {
  expect(prefs.get(1, 'nope', 'fallback')).toBe('fallback');
});

test('corrupt JSON returns the fallback', () => {
  db.prepare("INSERT INTO user_prefs (user_id, key, value) VALUES (1, 'bad', '{oops')").run();
  expect(prefs.get(1, 'bad', 7)).toBe(7);
});

test('an unserialisable value throws a clear error', () => {
  expect(() => prefs.set(1, 'k', undefined)).toThrow('prefs value must be JSON-serialisable');
});

test('values are per user', () => {
  prefs.set(1, 'k', 'one');
  prefs.set(2, 'k', 'two');
  expect(prefs.get(1, 'k', '')).toBe('one');
  expect(prefs.get(2, 'k', '')).toBe('two');
});
