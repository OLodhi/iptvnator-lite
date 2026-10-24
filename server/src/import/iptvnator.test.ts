import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createCurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createPersonalService } from '../personal/service.ts';
import { SERVER, iptvnatorFixture } from '../testing/iptvnatorDb.ts';
import type { Fixture } from '../testing/iptvnatorDb.ts';
import { ImportError, importIptvnator } from './iptvnator.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-iptvnator-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const fixture = (f: Fixture) => iptvnatorFixture(dir, f);

const USER = 1;

let db: Db;
let providerId: number;
const categoryId = new Map<string, number>();
const services = () => ({
  db,
  curation: createCurationService({ db, now: Date.now }),
  personal: createPersonalService({ db, now: Date.now }),
});

function addCategory(kind: string, remoteId: string, name: string, tag: string | null) {
  const id = Number(
    db
      .prepare('INSERT INTO categories (provider_id, kind, remote_id, name, position, seen_at, tag) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(providerId, kind, remoteId, name, tag).lastInsertRowid,
  );
  categoryId.set(`${kind}:${remoteId}`, id);
}

beforeEach(() => {
  db = openDb(':memory:');
  providerId = Number(
    db
      .prepare(`INSERT INTO providers (kind, name, config, account, created_at) VALUES ('xtream', 'p', ?, NULL, 0)`)
      .run(JSON.stringify({ serverUrl: SERVER, username: 'u', password: 'p' })).lastInsertRowid,
  );
  addCategory('live', '1', 'UK| General', 'UK');
  addCategory('live', '2', 'UK| Sports', 'UK');
  addCategory('live', '3', 'US| News', 'US');
  addCategory('live', '4', 'US| Movies', 'US');
  addCategory('live', '5', 'Misc', null);
  addCategory('movie', '10', 'Action', null);
  addCategory('movie', '11', 'Drama', null);
  for (const [kind, remoteId] of [['live', '1'], ['movie', '10'], ['series', '20']]) {
    db.prepare('INSERT INTO items (provider_id, kind, remote_id, name, seen_at) VALUES (?, ?, ?, ?, 0)').run(providerId, kind, remoteId, `item ${remoteId}`);
  }
});

const run = (file: string) => importIptvnator(services(), { file, providerId, userId: USER });
const rules = (kind: string) =>
  db.prepare('SELECT target_type AS type, target, visible FROM category_rules WHERE provider_id = ? AND kind = ? AND user_id IS NULL ORDER BY target_type, target').all(providerId, kind);

test('imports hidden categories as default rules for the matching provider', () => {
  const file = fixture({
    serverUrl: `${SERVER}/`,
    categories: [
      { type: 'live', xtreamId: 5, hidden: true },
      { type: 'live', xtreamId: 1 },
      { type: 'movies', xtreamId: 10 },
      { type: 'movies', xtreamId: 11, hidden: true },
      { type: 'movies', xtreamId: 99, hidden: true }, // not in our catalogue
    ],
  });
  expect(run(file)).toEqual({ categoriesMatched: 4, hiddenApplied: 2, favouritesImported: 0 });
  expect(rules('live')).toEqual([
    { type: 'category', target: '5', visible: 0 },
    { type: 'tag', target: 'UK', visible: 1 },
  ]);
  expect(rules('movie')).toEqual([
    { type: 'category', target: '10', visible: 1 },
    { type: 'category', target: '11', visible: 0 },
  ]);
  expect(rules('series')).toEqual([]);
  const visible = services().curation.visibleCategoryIds(providerId, 'movie', USER);
  expect([...visible]).toEqual([categoryId.get('movie:10')]);
});

test('hiding every US category and no UK one is a tag rule, not one rule per category', () => {
  const file = fixture({
    categories: [
      { type: 'live', xtreamId: 1 },
      { type: 'live', xtreamId: 2 },
      { type: 'live', xtreamId: 3, hidden: true },
      { type: 'live', xtreamId: 4, hidden: true },
    ],
  });
  expect(run(file)).toEqual({ categoriesMatched: 4, hiddenApplied: 2, favouritesImported: 0 });
  expect(rules('live')).toEqual([
    { type: 'tag', target: 'UK', visible: 1 },
    { type: 'tag', target: 'US', visible: 0 },
  ]);
  // A category synced in later follows its group.
  addCategory('live', '6', 'UK| Documentaries', 'UK');
  addCategory('live', '7', 'US| Kids', 'US');
  const visible = services().curation.visibleCategoryIds(providerId, 'live', USER);
  expect(visible.has(categoryId.get('live:6')!)).toBe(true);
  expect(visible.has(categoryId.get('live:7')!)).toBe(false);
});

test('the group majority sets the tag rule, a tie shows, and the minority become exceptions', () => {
  const file = fixture({
    categories: [
      { type: 'live', xtreamId: 1, hidden: true }, // UK: 1 hidden of 2 -> tie -> visible
      { type: 'live', xtreamId: 2 },
      { type: 'live', xtreamId: 3, hidden: true }, // US: 2 hidden of 2
      { type: 'live', xtreamId: 4, hidden: true },
    ],
  });
  expect(run(file)).toEqual({ categoriesMatched: 4, hiddenApplied: 3, favouritesImported: 0 });
  expect(rules('live')).toEqual([
    { type: 'category', target: '1', visible: 0 },
    { type: 'tag', target: 'UK', visible: 1 },
    { type: 'tag', target: 'US', visible: 0 },
  ]);
});

test('imports favourites by stream id and skips the ones we do not have', () => {
  const file = fixture({
    favourites: [
      { type: 'live', xtreamId: 1 },
      { type: 'movie', xtreamId: 10 },
      { type: 'series', xtreamId: 20 },
      { type: 'movie', xtreamId: 777 },
    ],
  });
  expect(run(file)).toEqual({ categoriesMatched: 0, hiddenApplied: 0, favouritesImported: 3 });
  const { personal } = services();
  expect(personal.favouriteItemIds(USER, providerId, 'live')).toHaveLength(1);
  expect(personal.favouriteItemIds(USER, providerId, 'movie')).toHaveLength(1);
  expect(personal.favouriteItemIds(USER, providerId, 'series')).toHaveLength(1);
});

test('rejects a non-IPTVnator file and writes nothing', () => {
  const text = path.join(dir, 'notes.txt');
  fs.writeFileSync(text, 'not a database at all');
  const bare = path.join(dir, 'bare.db');
  const other = new Database(bare);
  other.exec('CREATE TABLE playlists (id TEXT); CREATE TABLE unrelated (x)');
  other.close();
  for (const file of [text, bare]) {
    expect(() => run(file)).toThrowError(expect.objectContaining({ code: 'NOT_IPTVNATOR' }));
    expect(() => run(file)).toThrowError(ImportError);
  }
  expect(db.prepare('SELECT COUNT(*) FROM category_rules').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM favourites').pluck().get()).toBe(0);
});

test('rejects a file for a different provider', () => {
  for (const f of [{ serverUrl: 'http://elsewhere.example' }, { username: 'someone-else' }]) {
    const file = fixture({ ...f, categories: [{ type: 'live', xtreamId: 5, hidden: true }] });
    expect(() => run(file)).toThrowError(expect.objectContaining({ code: 'NO_MATCHING_PLAYLIST' }));
  }
  expect(db.prepare('SELECT COUNT(*) FROM category_rules').pluck().get()).toBe(0);
});

test('reads a WAL-mode database', () => {
  const file = fixture({ categories: [{ type: 'live', xtreamId: 5, hidden: true }] });
  const wal = new Database(file);
  wal.pragma('journal_mode = WAL');
  wal.close();
  expect(run(file).hiddenApplied).toBe(1);
});

test('a failure part-way through leaves nothing imported', () => {
  const file = fixture({
    categories: [{ type: 'live', xtreamId: 5, hidden: true }, { type: 'movies', xtreamId: 11, hidden: true }],
    favourites: [{ type: 'live', xtreamId: 1 }],
  });
  const personal = createPersonalService({ db, now: Date.now });
  const failing = { ...personal, addFavourite: () => { throw new Error('disk full'); } };
  expect(() =>
    importIptvnator({ db, curation: createCurationService({ db, now: Date.now }), personal: failing }, { file, providerId, userId: USER }),
  ).toThrowError('disk full');
  expect(db.prepare('SELECT COUNT(*) FROM category_rules').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM curation_state').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM favourites').pluck().get()).toBe(0);
});
