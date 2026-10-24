import path from 'node:path';
import Database from 'better-sqlite3';

export const SERVER = 'http://127.0.0.1:9999';

export type Cat = { type: 'live' | 'movies' | 'series'; xtreamId: number; hidden?: boolean };
export type Fav = { type: 'live' | 'movie' | 'series'; xtreamId: number };
export type Fixture = { serverUrl?: string; username?: string; categories?: Cat[]; favourites?: Fav[] };

let n = 0;
/** A small IPTVnator database: the same columns, one decoy playlist alongside the one under test. */
export function iptvnatorFixture(dir: string, f: Fixture): string {
  const file = path.join(dir, `iptvnator-${n++}.db`);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT, serverUrl TEXT, username TEXT, password TEXT,
      type TEXT CHECK (type IN ('xtream','stalker','m3u-file','m3u-text','m3u-url')));
    CREATE TABLE categories (id INTEGER PRIMARY KEY, playlist_id TEXT, name TEXT,
      type TEXT CHECK (type IN ('live','movies','series')), xtream_id INTEGER, hidden INTEGER DEFAULT 0,
      UNIQUE (playlist_id, type, xtream_id));
    CREATE TABLE content (id INTEGER PRIMARY KEY, category_id INTEGER, title TEXT, xtream_id INTEGER,
      type TEXT CHECK (type IN ('live','movie','series')));
    CREATE TABLE favorites (id INTEGER PRIMARY KEY, content_id INTEGER, playlist_id TEXT, added_at TEXT, position INTEGER);
  `);
  db.prepare('INSERT INTO playlists VALUES (?, ?, ?, ?, ?, ?)').run('pl1', 'Mine', f.serverUrl ?? `${SERVER}/`, f.username ?? 'u', 'secret', 'xtream');
  db.prepare('INSERT INTO playlists VALUES (?, ?, ?, ?, ?, ?)').run('pl2', 'Other', 'http://other.example', 'x', 'y', 'xtream');
  const cat = db.prepare('INSERT INTO categories (playlist_id, name, type, xtream_id, hidden) VALUES (?, ?, ?, ?, ?)');
  for (const c of f.categories ?? []) cat.run('pl1', `cat ${c.xtreamId}`, c.type, c.xtreamId, c.hidden ? 1 : 0);
  // A hidden category of the decoy playlist must never leak in.
  cat.run('pl2', 'decoy', 'live', 1, 1);
  const content = db.prepare('INSERT INTO content (title, xtream_id, type) VALUES (?, ?, ?)');
  const fav = db.prepare('INSERT INTO favorites (content_id, playlist_id, added_at, position) VALUES (?, ?, ?, ?)');
  for (const [i, v] of (f.favourites ?? []).entries()) {
    const id = Number(content.run(`title ${v.xtreamId}`, v.xtreamId, v.type).lastInsertRowid);
    fav.run(id, 'pl1', '2026-01-01', i);
  }
  db.close();
  return file;
}

