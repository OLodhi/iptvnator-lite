import { beforeEach, describe, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { CONTINUE_MOVIES_SQL, createPersonalService, HISTORY_LIMIT } from './service.ts';
import type { PersonalService } from './service.ts';

const USER = 1;
let db: Db;
let clock: number;
let personal: PersonalService;
const providerId = 1;

beforeEach(() => {
  db = openDb(':memory:');
  clock = 1000;
  personal = createPersonalService({ db, now: () => clock++ });
  db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'P', '{}', 0)").run();
});

const addItem = (kind: string, remoteId: string): number =>
  Number(
    db
      .prepare('INSERT INTO items (provider_id, kind, remote_id, name, seen_at) VALUES (?, ?, ?, ?, 0)')
      .run(providerId, kind, remoteId, `${kind} ${remoteId}`).lastInsertRowid,
  );
const addCategory = (kind: string, remoteId: string): number =>
  Number(
    db
      .prepare('INSERT INTO categories (provider_id, kind, remote_id, name, position, seen_at) VALUES (?, ?, ?, ?, 0, 0)')
      .run(providerId, kind, remoteId, `cat ${remoteId}`).lastInsertRowid,
  );
/** What a resync that prunes and re-creates a row does: the remote id stays, the row id changes. */
const recreateItem = (id: number): number => {
  const row = db.prepare('SELECT kind, remote_id AS remoteId FROM items WHERE id = ?').get(id) as { kind: string; remoteId: string };
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  return addItem(row.kind, row.remoteId);
};

describe('pins', () => {
  test('are listed in the order pinned and survive a re-created category', () => {
    const a = addCategory('live', 'a');
    const b = addCategory('live', 'b');
    expect(personal.pin(USER, b)).toBe(true);
    expect(personal.pin(USER, a)).toBe(true);
    personal.pin(USER, a); // pinning twice changes nothing
    expect(personal.pinnedCategoryIds(USER, providerId, 'live')).toEqual([b, a]);
    expect(personal.unpin(USER, b)).toBe(true);
    expect(personal.pinnedCategoryIds(USER, providerId, 'live')).toEqual([a]);

    db.prepare('DELETE FROM categories WHERE id = ?').run(a);
    expect(personal.pinnedCategoryIds(USER, providerId, 'live')).toEqual([]); // gone: skipped
    const again = addCategory('live', 'a');
    expect(personal.pinnedCategoryIds(USER, providerId, 'live')).toEqual([again]);
  });

  test('an unknown category is refused', () => {
    expect(personal.pin(USER, 999)).toBe(false);
    expect(personal.unpin(USER, 999)).toBe(false);
  });
});

describe('favourites', () => {
  test('survive a resync that re-creates the item, newest first', () => {
    const a = addItem('movie', '1');
    const b = addItem('movie', '2');
    personal.addFavourite(USER, a);
    personal.addFavourite(USER, b);
    expect(personal.favouriteItemIds(USER, providerId, 'movie')).toEqual([b, a]);
    expect(personal.favouriteItemIds(USER, providerId, 'live')).toEqual([]);

    const a2 = recreateItem(a);
    expect(a2).not.toBe(a);
    expect(personal.favouriteItemIds(USER, providerId, 'movie')).toEqual([b, a2]);
    expect(personal.removeFavourite(USER, a2)).toBe(true);
    expect(personal.favouriteItemIds(USER, providerId, 'movie')).toEqual([b]);
  });

  test('are kept per user', () => {
    db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 0)").run();
    const a = addItem('movie', '1');
    personal.addFavourite(2, a);
    expect(personal.favouriteItemIds(USER, providerId, 'movie')).toEqual([]);
    expect(personal.favouriteItemIds(2, providerId, 'movie')).toEqual([a]);
  });
});

describe('history', () => {
  test('recent keeps the latest 50 and moves a replay to the top', () => {
    const ids = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => addItem('live', String(i)));
    for (const id of ids) personal.recordPlay(USER, id, null);
    const recent = personal.recentItemIds(USER, providerId, 'live', 100);
    expect(recent).toHaveLength(HISTORY_LIMIT);
    expect(recent[0]).toBe(ids.at(-1));
    expect(recent.at(-1)).toBe(ids[5]);

    personal.recordPlay(USER, ids[10]!, null);
    const replayed = personal.recentItemIds(USER, providerId, 'live', 100);
    expect(replayed).toHaveLength(HISTORY_LIMIT);
    expect(replayed[0]).toBe(ids[10]);
    expect(replayed.filter((id) => id === ids[10])).toHaveLength(1);
    expect(personal.recentItemIds(USER, providerId, 'live', 3)).toHaveLength(3);
  });

  test('each kind keeps its own 50', () => {
    const live = addItem('live', '1');
    const movie = addItem('movie', '1');
    personal.recordPlay(USER, live, null);
    personal.recordPlay(USER, movie, null);
    expect(personal.recentItemIds(USER, providerId, 'live', 10)).toEqual([live]);
    expect(personal.recentItemIds(USER, providerId, 'movie', 10)).toEqual([movie]);
  });

  test('recordPlay stores the episode for series', () => {
    const series = addItem('series', '10');
    personal.recordPlay(USER, series, '201');
    expect(personal.recentItemIds(USER, providerId, 'series', 10)).toEqual([series]);
    expect(db.prepare('SELECT kind, remote_id AS r, episode_remote_id AS e FROM history').all()).toEqual([
      { kind: 'series', r: '10', e: '201' },
    ]);
    personal.recordPlay(USER, series, '202');
    expect(db.prepare('SELECT episode_remote_id FROM history').pluck().all()).toEqual(['202']);
  });

  test('an unknown item records nothing', () => {
    expect(personal.recordPlay(USER, 999, null)).toBe(false);
  });
});

describe('positions', () => {
  test('ignores near-zero reports', () => {
    const movie = addItem('movie', '1');
    personal.savePosition(USER, { itemId: movie, positionSec: 1800, durationSec: 7200 });
    personal.savePosition(USER, { itemId: movie, positionSec: 2, durationSec: 7200 });
    expect(personal.positions(USER, movie)).toMatchObject([{ episodeRemoteId: null, positionSec: 1800, finished: false }]);
  });

  test('marks a title finished at 95% and drops it from continue watching', () => {
    const movie = addItem('movie', '1');
    const other = addItem('movie', '2');
    personal.savePosition(USER, { itemId: movie, positionSec: 1000, durationSec: 2000 });
    personal.savePosition(USER, { itemId: other, positionSec: 100, durationSec: 2000 });
    expect(personal.continueWatching(USER, providerId, 'movie', 10).map((c) => c.itemId)).toEqual([other, movie]);

    personal.savePosition(USER, { itemId: movie, positionSec: 1899, durationSec: 2000 });
    expect(personal.positions(USER, movie)[0]!.finished).toBe(false);
    personal.savePosition(USER, { itemId: movie, positionSec: 1900, durationSec: 2000 });
    expect(personal.positions(USER, movie)[0]).toMatchObject({ positionSec: 1900, finished: true });
    expect(personal.continueWatching(USER, providerId, 'movie', 10)).toEqual([
      { itemId: other, episodeRemoteId: null, episodeLabel: null, positionSec: 100, durationSec: 2000 },
    ]);
  });

  test('an unknown duration is never finished', () => {
    const movie = addItem('movie', '1');
    personal.savePosition(USER, { itemId: movie, positionSec: 5000, durationSec: null });
    expect(personal.positions(USER, movie)[0]).toMatchObject({ finished: false, durationSec: null });
  });

  test('continue watching for series returns the latest unfinished episode per series', () => {
    const a = addItem('series', '10');
    const b = addItem('series', '20');
    personal.savePosition(USER, { itemId: a, episodeRemoteId: '101', positionSec: 100, durationSec: 1000 });
    personal.savePosition(USER, { itemId: a, episodeRemoteId: '102', positionSec: 200, durationSec: 1000 }, 'S1 E2');
    personal.savePosition(USER, { itemId: b, episodeRemoteId: '201', positionSec: 300, durationSec: 1000 });
    personal.savePosition(USER, { itemId: a, episodeRemoteId: '103', positionSec: 990, durationSec: 1000 }); // finished

    expect(personal.continueWatching(USER, providerId, 'series', 10)).toEqual([
      { itemId: b, episodeRemoteId: '201', episodeLabel: null, positionSec: 300, durationSec: 1000 },
      { itemId: a, episodeRemoteId: '102', episodeLabel: 'S1 E2', positionSec: 200, durationSec: 1000 },
    ]);
    expect(personal.continueWatching(USER, providerId, 'series', 1)).toHaveLength(1);
    expect(personal.continueWatching(USER, providerId, 'movie', 10)).toEqual([]);

    expect(personal.positions(USER, a).map((p) => p.episodeRemoteId)).toEqual(['103', '102', '101']);
    expect(personal.positions(USER, a)[0]!.finished).toBe(true);
  });

  test('positions survive a re-created item and skip a vanished one', () => {
    const movie = addItem('movie', '1');
    personal.savePosition(USER, { itemId: movie, positionSec: 100, durationSec: 1000 });
    const again = recreateItem(movie);
    expect(personal.positions(USER, again)).toHaveLength(1);
    expect(personal.continueWatching(USER, providerId, 'movie', 10).map((c) => c.itemId)).toEqual([again]);
    db.prepare('DELETE FROM items WHERE id = ?').run(again);
    expect(personal.continueWatching(USER, providerId, 'movie', 10)).toEqual([]);
  });

  test('continue watching looks movies up by the items index, not a scan', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${CONTINUE_MOVIES_SQL}`).all(USER, providerId, 10) as { detail: string }[];
    const details = plan.map((r) => r.detail);
    const items = details.filter((d) => /^(SEARCH|SCAN) i( |$)/.test(d));
    expect(items, details.join('\n')).toHaveLength(1);
    expect(items[0]).toMatch(/^SEARCH i USING (COVERING )?INDEX \w+ \(provider_id=\? AND kind=\? AND remote_id=\?\)/);
  });

  test('an episode position is never mistaken for a movie', () => {
    addItem('movie', 'de:201'); // what 'episode:201' looks like with a movie prefix cut off
    const s = addItem('series', '10');
    personal.savePosition(USER, { itemId: s, episodeRemoteId: '201', positionSec: 100, durationSec: 1000 });
    expect(personal.continueWatching(USER, providerId, 'movie', 10)).toEqual([]);
  });

  test('an unknown item is refused', () => {
    expect(personal.savePosition(USER, { itemId: 999, positionSec: 100, durationSec: null })).toBe(false);
    expect(personal.positions(USER, 999)).toEqual([]);
  });
});
