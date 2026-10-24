import type { Db } from '../db/db.ts';

/** Small per-user settings, stored as JSON so any value shape round-trips. */
export interface PrefsService {
  /** The stored value, or `fallback` when the key is missing or its JSON is unparseable. */
  get<T>(userId: number, key: string, fallback: T): T;
  set(userId: number, key: string, value: unknown): void;
}

export function createPrefsService(db: Db): PrefsService {
  const select = db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?');
  const upsert = db.prepare(
    'INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value',
  );
  return {
    get<T>(userId: number, key: string, fallback: T): T {
      const row = select.get(userId, key) as { value: string } | undefined;
      if (!row) return fallback;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return fallback;
      }
    },
    set(userId, key, value) {
      upsert.run(userId, key, JSON.stringify(value));
    },
  };
}
