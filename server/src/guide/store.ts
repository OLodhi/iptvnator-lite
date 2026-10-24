import type { Db } from '../db/db.ts';

export type GuideChannelRow = { key: string; name: string; names: string[] };
export type ProgrammeRow = {
  channelKey: string;
  start: number;
  stop: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
};
export type GuideStateRow = {
  generation: number;
  fetchedAt: number | null;
  attemptedAt: number | null;
  source: 'xmltv' | 'provider' | null;
  failures: number;
  lastError: string | null;
};

/** Longest text stored per programme field; longer values are truncated on insert. */
export const TEXT_LIMITS = { title: 300, subtitle: 300, description: 1000, category: 100 };

const DELETE_CHUNK = 1000;

/**
 * Guide data is written into a new generation that readers cannot see: a provider's `guide_state.generation`
 * is the only generation queries use, and it moves only in `commitGeneration`. A failed refresh is abandoned
 * or recorded without ever touching what readers see.
 */
export interface GuideStore {
  state(providerId: number): GuideStateRow | null;
  /** 0 means never fetched. */
  currentGeneration(providerId: number): number;
  /** Returns current + 1 and records the attempt; readers still see the current generation. */
  beginGeneration(providerId: number, now: number): number;
  insertChannels(providerId: number, generation: number, rows: GuideChannelRow[]): void;
  /** Returns how many rows were new; a repeated (channel, start) is ignored. */
  insertProgrammes(providerId: number, generation: number, rows: ProgrammeRow[]): number;
  commitGeneration(providerId: number, generation: number, meta: { fetchedAt: number; source: 'xmltv' | 'provider' }): void;
  recordFailure(providerId: number, error: string): void;
  abandonGeneration(providerId: number, generation: number): Promise<void>;
  /** Removes every generation except the current one; returns the rows removed. */
  pruneGenerations(providerId: number): Promise<number>;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const cut = (text: string | null, limit: number): string | null => (text === null ? null : text.slice(0, limit));

export function createGuideStore(db: Db): GuideStore {
  const selectState = db.prepare(
    `SELECT generation, fetched_at AS fetchedAt, attempted_at AS attemptedAt, source, failures, last_error AS lastError
       FROM guide_state WHERE provider_id = ?`,
  );
  const selectGeneration = db.prepare('SELECT generation FROM guide_state WHERE provider_id = ?');
  const touch = db.prepare(
    `INSERT INTO guide_state (provider_id, attempted_at) VALUES (?, ?)
       ON CONFLICT (provider_id) DO UPDATE SET attempted_at = excluded.attempted_at`,
  );
  const insertChannel = db.prepare(
    'INSERT OR REPLACE INTO guide_channels (provider_id, generation, key, name, names) VALUES (?, ?, ?, ?, ?)',
  );
  const insertProgramme = db.prepare(
    `INSERT OR IGNORE INTO programmes (provider_id, generation, channel_key, start, stop, title, subtitle, description, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const commit = db.prepare(
    `INSERT INTO guide_state (provider_id, generation, fetched_at, source) VALUES (?, ?, ?, ?)
       ON CONFLICT (provider_id) DO UPDATE SET generation = excluded.generation, fetched_at = excluded.fetched_at,
         source = excluded.source, failures = 0, last_error = NULL`,
  );
  const fail = db.prepare(
    `INSERT INTO guide_state (provider_id, failures, last_error) VALUES (?, 1, ?)
       ON CONFLICT (provider_id) DO UPDATE SET failures = failures + 1, last_error = excluded.last_error`,
  );

  const currentGeneration = (providerId: number): number =>
    (selectGeneration.get(providerId) as { generation: number } | undefined)?.generation ?? 0;

  const insertChannels = db.transaction((providerId: number, generation: number, rows: GuideChannelRow[]) => {
    for (const r of rows) insertChannel.run(providerId, generation, r.key, r.name, JSON.stringify(r.names));
  });
  const insertProgrammes = db.transaction((providerId: number, generation: number, rows: ProgrammeRow[]) => {
    let inserted = 0;
    for (const r of rows) {
      inserted += insertProgramme.run(
        providerId,
        generation,
        r.channelKey,
        r.start,
        r.stop,
        r.title.slice(0, TEXT_LIMITS.title),
        cut(r.subtitle, TEXT_LIMITS.subtitle),
        cut(r.description, TEXT_LIMITS.description),
        cut(r.category, TEXT_LIMITS.category),
      ).changes;
    }
    return inserted;
  });

  /** Chunked so a large generation never blocks the event loop; `where` is a fixed fragment, never user input. */
  async function deleteInChunks(table: string, where: string, args: number[]): Promise<number> {
    const stmt = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${DELETE_CHUNK})`);
    const once = db.transaction(() => stmt.run(...args).changes);
    let total = 0;
    for (;;) {
      const n = once();
      total += n;
      if (n < DELETE_CHUNK) return total;
      await yieldToEventLoop();
    }
  }

  return {
    state: (providerId) => (selectState.get(providerId) as GuideStateRow | undefined) ?? null,
    currentGeneration,
    beginGeneration(providerId, now) {
      touch.run(providerId, now);
      return currentGeneration(providerId) + 1;
    },
    insertChannels: (providerId, generation, rows) => insertChannels(providerId, generation, rows),
    insertProgrammes: (providerId, generation, rows) => insertProgrammes(providerId, generation, rows),
    commitGeneration(providerId, generation, meta) {
      commit.run(providerId, generation, meta.fetchedAt, meta.source);
    },
    recordFailure(providerId, error) {
      fail.run(providerId, error);
    },
    async abandonGeneration(providerId, generation) {
      await deleteInChunks('programmes', 'provider_id = ? AND generation = ?', [providerId, generation]);
      await deleteInChunks('guide_channels', 'provider_id = ? AND generation = ?', [providerId, generation]);
    },
    async pruneGenerations(providerId) {
      const current = currentGeneration(providerId);
      let removed = await deleteInChunks('programmes', 'provider_id = ? AND generation <> ?', [providerId, current]);
      removed += await deleteInChunks('guide_channels', 'provider_id = ? AND generation <> ?', [providerId, current]);
      return removed;
    },
  };
}
