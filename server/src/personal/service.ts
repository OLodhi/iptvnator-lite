import type { Kind, PositionReport, SavedPosition } from '@tv/shared';
import type { Db } from '../db/db.ts';

/** Most recent titles kept per user, provider and kind. */
export const HISTORY_LIMIT = 50;
/** A title watched to this fraction of its duration counts as finished. */
export const FINISHED_RATIO = 0.95;
/** Reports earlier than this are ignored so an accidental start never overwrites a real resume point. */
export const MIN_POSITION_SEC = 5;

export type ContinueEntry = {
  itemId: number;
  episodeRemoteId: string | null;
  /** "S<season> E<num>" as saved with the position; null for a movie. */
  episodeLabel: string | null;
  positionSec: number;
  durationSec: number | null;
};

/**
 * Personal data keys on provider remote ids, not row ids, so it survives a resync that prunes and re-creates
 * items. Ids are resolved back by joining the current catalogue; rows whose item or category is gone are skipped.
 */
export interface PersonalService {
  /** Each write returns false when the category or item does not exist. */
  pin(userId: number, categoryId: number): boolean;
  unpin(userId: number, categoryId: number): boolean;
  /** In the order pinned. */
  pinnedCategoryIds(userId: number, providerId: number, kind: Kind): number[];
  addFavourite(userId: number, itemId: number): boolean;
  removeFavourite(userId: number, itemId: number): boolean;
  /** Newest first. */
  favouriteItemIds(userId: number, providerId: number, kind: Kind): number[];
  /** Episodes are recorded under their series. */
  recordPlay(userId: number, itemId: number, episodeRemoteId: string | null): boolean;
  recentItemIds(userId: number, providerId: number, kind: Kind, limit: number): number[];
  /** `episodeLabel` is kept with an episode's position so browsing never has to ask the provider. */
  savePosition(userId: number, report: PositionReport, episodeLabel?: string): boolean;
  positions(userId: number, itemId: number): SavedPosition[];
  /**
   * Marks episodes of a series watched (a finished, manual row) or unwatched (the rows are deleted), in one
   * transaction. Manual rows are finished, so they never become a Continue entry. An unknown item changes nothing.
   */
  markWatched(userId: number, itemId: number, episodes: { remoteId: string; label: string; durationSec: number | null }[], watched: boolean): void;
  continueWatching(userId: number, providerId: number, kind: 'movie' | 'series', limit: number): ContinueEntry[];
}

type Ref = { providerId: number; kind: Kind; remoteId: string };

type PositionRow = {
  contentKey: string;
  positionSec: number;
  durationSec: number | null;
  finished: number;
  manual: number;
  updatedAt: number;
};

const EPISODE_PREFIX = 'episode:';
const MOVIE_PREFIX = 'movie:';

/** The expression sits on the positions side so the join can search items by its unique (provider, kind, remote id) index. */
export const CONTINUE_MOVIES_SQL = `SELECT i.id AS itemId, NULL AS episodeRemoteId, NULL AS episodeLabel, p.position_sec AS positionSec, p.duration_sec AS durationSec
     FROM positions p JOIN items i
       ON i.provider_id = p.provider_id AND i.kind = 'movie' AND i.remote_id = substr(p.content_key, ${MOVIE_PREFIX.length + 1})
     WHERE p.user_id = ? AND p.provider_id = ? AND p.finished = 0 AND p.content_key LIKE '${MOVIE_PREFIX}%'
     ORDER BY p.updated_at DESC, p.rowid DESC LIMIT ?`;

export function createPersonalService(deps: { db: Db; now: () => number }): PersonalService {
  const { db } = deps;
  const category = db.prepare('SELECT provider_id AS providerId, kind, remote_id AS remoteId FROM categories WHERE id = ?');
  const item = db.prepare('SELECT provider_id AS providerId, kind, remote_id AS remoteId FROM items WHERE id = ?');
  const ref = (stmt: typeof category, id: number) => stmt.get(id) as Ref | undefined;

  const insertPin = db.prepare(
    'INSERT OR IGNORE INTO pins (user_id, provider_id, kind, category_remote_id, pinned_at) VALUES (?, ?, ?, ?, ?)',
  );
  const deletePin = db.prepare(
    'DELETE FROM pins WHERE user_id = ? AND provider_id = ? AND kind = ? AND category_remote_id = ?',
  );
  const pinned = db
    .prepare(
      `SELECT c.id FROM pins p JOIN categories c
         ON c.provider_id = p.provider_id AND c.kind = p.kind AND c.remote_id = p.category_remote_id
       WHERE p.user_id = ? AND p.provider_id = ? AND p.kind = ? ORDER BY p.pinned_at, p.rowid`,
    )
    .pluck();

  const insertFavourite = db.prepare(
    'INSERT OR IGNORE INTO favourites (user_id, provider_id, kind, remote_id, added_at) VALUES (?, ?, ?, ?, ?)',
  );
  const deleteFavourite = db.prepare(
    'DELETE FROM favourites WHERE user_id = ? AND provider_id = ? AND kind = ? AND remote_id = ?',
  );
  const favourites = db
    .prepare(
      `SELECT i.id FROM favourites f JOIN items i
         ON i.provider_id = f.provider_id AND i.kind = f.kind AND i.remote_id = f.remote_id
       WHERE f.user_id = ? AND f.provider_id = ? AND f.kind = ? ORDER BY f.added_at DESC, f.rowid DESC`,
    )
    .pluck();

  // REPLACE rather than upsert: a replay gets a fresh rowid, which breaks ties between equal timestamps.
  const insertHistory = db.prepare(
    `INSERT OR REPLACE INTO history (user_id, provider_id, kind, remote_id, episode_remote_id, watched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const pruneHistory = db.prepare(
    `DELETE FROM history WHERE user_id = ? AND provider_id = ? AND kind = ? AND rowid NOT IN (
       SELECT rowid FROM history WHERE user_id = ? AND provider_id = ? AND kind = ?
       ORDER BY watched_at DESC, rowid DESC LIMIT ${HISTORY_LIMIT})`,
  );
  const recent = db
    .prepare(
      `SELECT i.id FROM history h JOIN items i
         ON i.provider_id = h.provider_id AND i.kind = h.kind AND i.remote_id = h.remote_id
       WHERE h.user_id = ? AND h.provider_id = ? AND h.kind = ? ORDER BY h.watched_at DESC, h.rowid DESC LIMIT ?`,
    )
    .pluck();

  const upsertPosition = db.prepare(
    `INSERT INTO positions (user_id, provider_id, content_key, series_remote_id, episode_label, position_sec, duration_sec, finished, manual, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (user_id, provider_id, content_key) DO UPDATE SET
       series_remote_id = excluded.series_remote_id, episode_label = excluded.episode_label, position_sec = excluded.position_sec,
       duration_sec = excluded.duration_sec, finished = excluded.finished, manual = 0, updated_at = excluded.updated_at`,
  );
  const POSITION_COLUMNS = `content_key AS contentKey, position_sec AS positionSec, duration_sec AS durationSec,
    finished, manual, updated_at AS updatedAt`;
  const moviePosition = db.prepare(
    `SELECT ${POSITION_COLUMNS} FROM positions WHERE user_id = ? AND provider_id = ? AND content_key = ?`,
  );
  const seriesPositions = db.prepare(
    `SELECT ${POSITION_COLUMNS} FROM positions WHERE user_id = ? AND provider_id = ? AND series_remote_id = ?
     ORDER BY updated_at DESC, rowid DESC`,
  );
  const upsertWatched = db.prepare(
    `INSERT INTO positions (user_id, provider_id, content_key, series_remote_id, episode_label, position_sec, duration_sec, finished, manual, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
     ON CONFLICT (user_id, provider_id, content_key) DO UPDATE SET
       series_remote_id = excluded.series_remote_id, episode_label = excluded.episode_label, position_sec = excluded.position_sec,
       duration_sec = excluded.duration_sec, finished = 1, manual = 1, updated_at = excluded.updated_at`,
  );
  const deletePosition = db.prepare('DELETE FROM positions WHERE user_id = ? AND provider_id = ? AND content_key = ?');
  const continueMovies = db.prepare(CONTINUE_MOVIES_SQL);
  const continueSeries = db.prepare(
    `SELECT i.id AS itemId, substr(p.content_key, ${EPISODE_PREFIX.length + 1}) AS episodeRemoteId,
            p.episode_label AS episodeLabel, p.position_sec AS positionSec, p.duration_sec AS durationSec
     FROM (SELECT *, rowid AS rid, ROW_NUMBER() OVER (PARTITION BY series_remote_id ORDER BY updated_at DESC, rowid DESC) AS n
           FROM positions
           WHERE user_id = ? AND provider_id = ? AND finished = 0 AND series_remote_id IS NOT NULL) p
     JOIN items i ON i.provider_id = p.provider_id AND i.kind = 'series' AND i.remote_id = p.series_remote_id
     WHERE p.n = 1 ORDER BY p.updated_at DESC, p.rid DESC LIMIT ?`,
  );

  const toSaved = (r: PositionRow): SavedPosition => ({
    episodeRemoteId: r.contentKey.startsWith(EPISODE_PREFIX) ? r.contentKey.slice(EPISODE_PREFIX.length) : null,
    positionSec: r.positionSec,
    durationSec: r.durationSec,
    finished: r.finished === 1,
    manual: r.manual === 1,
    updatedAt: r.updatedAt,
  });

  return {
    pin(userId, categoryId) {
      const c = ref(category, categoryId);
      if (c) insertPin.run(userId, c.providerId, c.kind, c.remoteId, deps.now());
      return c !== undefined;
    },
    unpin(userId, categoryId) {
      const c = ref(category, categoryId);
      if (c) deletePin.run(userId, c.providerId, c.kind, c.remoteId);
      return c !== undefined;
    },
    pinnedCategoryIds: (userId, providerId, kind) => pinned.all(userId, providerId, kind) as number[],
    addFavourite(userId, itemId) {
      const i = ref(item, itemId);
      if (i) insertFavourite.run(userId, i.providerId, i.kind, i.remoteId, deps.now());
      return i !== undefined;
    },
    removeFavourite(userId, itemId) {
      const i = ref(item, itemId);
      if (i) deleteFavourite.run(userId, i.providerId, i.kind, i.remoteId);
      return i !== undefined;
    },
    favouriteItemIds: (userId, providerId, kind) => favourites.all(userId, providerId, kind) as number[],
    recordPlay(userId, itemId, episodeRemoteId) {
      const i = ref(item, itemId);
      if (!i) return false;
      db.transaction(() => {
        insertHistory.run(userId, i.providerId, i.kind, i.remoteId, episodeRemoteId, deps.now());
        pruneHistory.run(userId, i.providerId, i.kind, userId, i.providerId, i.kind);
      })();
      return true;
    },
    recentItemIds: (userId, providerId, kind, limit) => recent.all(userId, providerId, kind, limit) as number[],
    savePosition(userId, report, episodeLabel) {
      const i = ref(item, report.itemId);
      if (!i) return false;
      if (report.positionSec < MIN_POSITION_SEC) return true;
      const { durationSec } = report;
      const finished = durationSec !== null && durationSec > 0 && report.positionSec / durationSec >= FINISHED_RATIO;
      const episode = report.episodeRemoteId;
      upsertPosition.run(
        userId,
        i.providerId,
        episode === undefined ? `movie:${i.remoteId}` : `${EPISODE_PREFIX}${episode}`,
        episode === undefined ? null : i.remoteId,
        episode === undefined ? null : (episodeLabel ?? null),
        report.positionSec,
        durationSec,
        finished ? 1 : 0,
        deps.now(),
      );
      return true;
    },
    positions(userId, itemId) {
      const i = ref(item, itemId);
      if (!i) return [];
      const rows =
        i.kind === 'series'
          ? seriesPositions.all(userId, i.providerId, i.remoteId)
          : i.kind === 'movie'
            ? moviePosition.all(userId, i.providerId, `movie:${i.remoteId}`)
            : [];
      return (rows as PositionRow[]).map(toSaved);
    },
    markWatched(userId, itemId, episodes, watched) {
      const i = ref(item, itemId);
      if (!i || i.kind !== 'series') return;
      db.transaction(() => {
        for (const e of episodes) {
          const key = `${EPISODE_PREFIX}${e.remoteId}`;
          if (watched) upsertWatched.run(userId, i.providerId, key, i.remoteId, e.label, e.durationSec ?? 0, e.durationSec, deps.now());
          else deletePosition.run(userId, i.providerId, key);
        }
      })();
    },
    continueWatching(userId, providerId, kind, limit) {
      const stmt = kind === 'movie' ? continueMovies : continueSeries;
      return stmt.all(userId, providerId, limit) as ContinueEntry[];
    },
  };
}
