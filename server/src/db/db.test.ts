import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { openDb, type Db } from './db.ts';
import { migrations } from './migrations.ts';

function search(db: Db, term: string): string[] {
  const rows = db
    .prepare('SELECT items.name AS name FROM items JOIN items_fts ON items_fts.rowid = items.id WHERE items_fts MATCH ?')
    .all(term) as { name: string }[];
  return rows.map((r) => r.name);
}

function seed(db: Db): void {
  db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'P', '{}', 0)").run();
  db.prepare(
    "INSERT INTO categories (id, provider_id, kind, remote_id, name, position, seen_at) VALUES (1, 1, 'live', 'c1', 'Cat', 0, 0)",
  ).run();
  const ins = db.prepare("INSERT INTO items (id, provider_id, kind, remote_id, name, seen_at) VALUES (?, 1, 'live', ?, ?, 0)");
  ins.run(1, 'a', 'Sky Sports Main Event');
  ins.run(2, 'b', 'Télé Matin');
  db.prepare('INSERT INTO item_categories (category_id, item_id, position) VALUES (1, 1, 0), (1, 2, 1)').run();
}

test('applies all migrations and records the version', () => {
  const db = openDb(':memory:');
  expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
});

test('reopening an existing file is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-db-'));
  const file = path.join(dir, 'tv.sqlite');
  const first = openDb(file);
  seed(first);
  first.close();
  const second = openDb(file);
  expect(second.pragma('user_version', { simple: true })).toBe(migrations.length);
  expect(second.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 2 });
  second.close();
});

test('title search is substring, case- and accent-insensitive', () => {
  const db = openDb(':memory:');
  seed(db);
  expect(search(db, 'spor')).toEqual(['Sky Sports Main Event']);
  expect(search(db, 'tele')).toEqual(['Télé Matin']);
});

test('fts stays in sync on rename and delete', () => {
  const db = openDb(':memory:');
  seed(db);
  db.prepare("UPDATE items SET name = 'Discovery Channel' WHERE id = 1").run();
  expect(search(db, 'spor')).toEqual([]);
  expect(search(db, 'discov')).toEqual(['Discovery Channel']);
  db.prepare('DELETE FROM items WHERE id = 2').run();
  expect(search(db, 'tele')).toEqual([]);
});

test('deleting a provider removes its categories, items and links', () => {
  const db = openDb(':memory:');
  seed(db);
  db.prepare('DELETE FROM providers WHERE id = 1').run();
  for (const table of ['categories', 'items', 'item_categories']) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(search(db, 'spor')).toEqual([]);
});

test('migration 2 seeds the default user', () => {
  const db = openDb(':memory:');
  expect(db.prepare('SELECT id, name FROM users').all()).toEqual([{ id: 1, name: 'Owner' }]);
});

test('renaming an item to the same name does not touch the FTS index', () => {
  const db = openDb(':memory:');
  seed(db);
  const snapshot = () => JSON.stringify(db.prepare('SELECT id, block FROM items_fts_data ORDER BY id').all());
  const before = snapshot();
  db.prepare("UPDATE items SET name = 'Sky Sports Main Event' WHERE id = 1").run();
  expect(snapshot()).toBe(before);
  db.prepare("UPDATE items SET name = 'Beta' WHERE id = 1").run();
  expect(search(db, 'spor')).toEqual([]);
  expect(search(db, 'bet')).toEqual(['Beta']);
});

test('a failing migration rolls back and leaves user_version unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-db-'));
  const file = path.join(dir, 'tv.sqlite');
  expect(() => openDb(file, { migrations: [...migrations, 'CREATE TABLE ok (x); THIS IS NOT SQL'] })).toThrow();
  const db = openDb(file);
  expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all()).toEqual([]);
  db.close();
});

test('deleting a provider cascades personal and curation rows', () => {
  const db = openDb(':memory:');
  seed(db);
  db.exec(`
    INSERT INTO category_rules (provider_id, user_id, kind, target_type, target, visible) VALUES (1, NULL, 'live', 'tag', 'UK', 1);
    INSERT INTO curation_state (provider_id, user_id, kind, saved_at) VALUES (1, NULL, 'live', 0);
    INSERT INTO pins (user_id, provider_id, kind, category_remote_id, pinned_at) VALUES (1, 1, 'live', 'c1', 0);
    INSERT INTO favourites (user_id, provider_id, kind, remote_id, added_at) VALUES (1, 1, 'live', 'a', 0);
    INSERT INTO history (user_id, provider_id, kind, remote_id, watched_at) VALUES (1, 1, 'live', 'a', 0);
    INSERT INTO positions (user_id, provider_id, content_key, position_sec, updated_at) VALUES (1, 1, 'movie:a', 5, 0);
    INSERT INTO catalogue_styles (provider_id, kind, style) VALUES (1, 'live', 'tagged');
  `);
  db.prepare('DELETE FROM providers WHERE id = 1').run();
  for (const table of ['category_rules', 'pins', 'favourites', 'history', 'positions', 'curation_state', 'catalogue_styles']) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
});
