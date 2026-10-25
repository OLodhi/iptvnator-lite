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
  /** Returns a number above every generation present, leftovers included; readers still see the current one. */
  beginGeneration(providerId: number, now: number): number;
  insertChannels(providerId: number, generation: number, rows: GuideChannelRow[]): void;
  /** Returns how many rows were new; a repeated (channel, start) is ignored. */
  insertProgrammes(providerId: number, generation: number, rows: ProgrammeRow[]): number;
  /** Throws unless `generation` is newer than the current one, so a stale caller cannot roll the guide back. */
  commitGeneration(providerId: number, generation: number, meta: { fetchedAt: number; source: 'xmltv' | 'provider' }): void;
  /** Counts a failed refresh and stamps the attempt (`now`, seconds), so the scheduler's backoff has an anchor. */
  recordFailure(providerId: number, error: string, now: number): void;
  abandonGeneration(providerId: number, generation: number): Promise<void>;
  /** Removes every generation older than the current one; returns the rows removed. */
  pruneGenerations(providerId: number): Promise<number>;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Cuts to `limit` UTF-16 units without leaving half of a surrogate pair at the end. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

const cut = (text: string | null, limit: number): string | null => (text === null ? null : truncate(text, limit));

export function createGuideStore(db: Db): GuideStore {
  const selectState = db.prepare(
    `SELECT generation, fetched_at AS fetchedAt, attempted_at AS attemptedAt, source, failures, last_error AS lastError
       FROM guide_state WHERE provider_id = ?`,
  );
  const selectGeneration = db.prepare('SELECT generation FROM guide_state WHERE provider_id = ?');
  const highestGeneration = db.prepare(
    `SELECT MAX(
       COALESCE((SELECT generation FROM guide_state WHERE provider_id = @p), 0),
       COALESCE((SELECT MAX(generation) FROM programmes WHERE provider_id = @p), 0),
       COALESCE((SELECT MAX(generation) FROM guide_channels WHERE provider_id = @p), 0)) AS n`,
  );
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
    `INSERT INTO guide_state (provider_id, failures, last_error, attempted_at) VALUES (?, 1, ?, ?)
       ON CONFLICT (provider_id) DO UPDATE SET failures = failures + 1, last_error = excluded.last_error,
         attempted_at = excluded.attempted_at`,
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
        truncate(r.title, TEXT_LIMITS.title),
        cut(r.subtitle, TEXT_LIMITS.subtitle),
        cut(r.description, TEXT_LIMITS.description),
        cut(r.category, TEXT_LIMITS.category),
      ).changes;
    }
    return inserted;
  });

  /**
   * Chunked so a large generation never blocks the event loop, and yielding before each chunk so the first never
   * extends the caller's own synchronous work. `where` and `order` are fixed fragments, never user input. `order` is
   * the table's key index, so each chunk removes rows that were written together: in the planner's own pick (the stop
   * index) a chunk touches scattered pages, and on 377k programmes the prune took 31 s instead of 7 s.
   * `proceed` is re-checked before every chunk because the world can change while the loop yields.
   */
  async function deleteInChunks(
    table: string,
    where: string,
    order: string,
    args: number[],
    proceed: () => boolean = () => true,
  ): Promise<number> {
    const stmt = db.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${DELETE_CHUNK})`,
    );
    const once = db.transaction(() => stmt.run(...args).changes);
    let total = 0;
    for (;;) {
      await yieldToEventLoop();
      if (!proceed()) break;
      const n = once();
      total += n;
      if (n < DELETE_CHUNK) break;
    }
    return total;
  }

  const PROGRAMMES_ORDER = 'generation, channel_key, start'; // programmes_slot
  const CHANNELS_ORDER = 'generation, key'; // the primary key

  return {
    state: (providerId) => (selectState.get(providerId) as GuideStateRow | undefined) ?? null,
    currentGeneration,
    beginGeneration(providerId, now) {
      touch.run(providerId, now);
      return (highestGeneration.get({ p: providerId }) as { n: number }).n + 1;
    },
    insertChannels: (providerId, generation, rows) => insertChannels(providerId, generation, rows),
    insertProgrammes: (providerId, generation, rows) => insertProgrammes(providerId, generation, rows),
    commitGeneration(providerId, generation, meta) {
      if (generation <= currentGeneration(providerId)) {
        throw new Error(`generation ${generation} is not newer than the current generation`);
      }
      commit.run(providerId, generation, meta.fetchedAt, meta.source);
    },
    recordFailure(providerId, error, now) {
      fail.run(providerId, error, now);
    },
    async abandonGeneration(providerId, generation) {
      const proceed = () => generation > currentGeneration(providerId);
      const args = [providerId, generation];
      await deleteInChunks('programmes', 'provider_id = ? AND generation = ?', PROGRAMMES_ORDER, args, proceed);
      await deleteInChunks('guide_channels', 'provider_id = ? AND generation = ?', CHANNELS_ORDER, args, proceed);
    },
    async pruneGenerations(providerId) {
      // Strictly older than current: a commit landing mid-prune, or an in-flight newer generation, is never touched.
      const args = [providerId, currentGeneration(providerId)];
      let removed = await deleteInChunks('programmes', 'provider_id = ? AND generation < ?', PROGRAMMES_ORDER, args);
      removed += await deleteInChunks('guide_channels', 'provider_id = ? AND generation < ?', CHANNELS_ORDER, args);
      return removed;
    },
  };
}
