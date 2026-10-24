import Database from 'better-sqlite3';
import { migrations as defaultMigrations } from './migrations.ts';

export type Db = import('better-sqlite3').Database;

export function openDb(file: string, opts: { migrations?: string[] } = {}): Db {
  const migrations = opts.migrations ?? defaultMigrations;
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    const apply = db.transaction(() => {
      db.exec(migrations[i]!);
      db.pragma(`user_version = ${i + 1}`);
    });
    apply();
  }
  return db;
}
