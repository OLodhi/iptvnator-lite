import { beforeEach, describe, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createGuideQueries } from './query.ts';
import type { GuideQueries } from './query.ts';
import { createGuideStore } from './store.ts';
import type { GuideStore, ProgrammeRow } from './store.ts';

let db: Db;
let store: GuideStore;
let q: GuideQueries;
const P = 1;
const NOW = 10_000_000;
const HOUR = 3600;

const prog = (channelKey: string, start: number, stop: number, title = 'T'): ProgrammeRow => ({
  channelKey, start, stop, title, subtitle: null, description: null, category: null,
});
const item = (id: number, key: string | null, catchupDays: number | null = null) => {
  db.prepare(
    `INSERT INTO items (id, provider_id, kind, remote_id, name, catchup_days, seen_at) VALUES (?, 1, 'live', ?, ?, ?, 0)`,
  ).run(id, `r${id}`, `Item ${id}`, catchupDays);
  if (key) db.prepare("INSERT INTO guide_links (item_id, provider_id, channel_key, method) VALUES (?, 1, ?, 'id')").run(id, key);
};
/** Writes a generation and commits it. */
function seed(rows: ProgrammeRow[], channels: { key: string; name: string; names?: string[] }[] = []): number {
  const g = store.beginGeneration(P, 0);
  store.insertChannels(P, g, channels.map((c) => ({ key: c.key, name: c.name, names: c.names ?? [c.name] })));
  store.insertProgrammes(P, g, rows);
  store.commitGeneration(P, g, { fetchedAt: 0, source: 'xmltv' });
  return g;
}

beforeEach(() => {
  db = openDb(':memory:');
  store = createGuideStore(db);
  q = createGuideQueries(db);
  db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'P', '{}', 0)").run();
});

describe('guide queries', () => {
  test('nowFor finds the airing programme only', () => {
    item(1, 'a');
    item(2, 'b');
    item(3, 'c');
    item(4, 'd');
    seed([
      prog('a', NOW - 2 * HOUR, NOW - HOUR, 'a-before'),
      prog('a', NOW - HOUR, NOW + HOUR, 'a-now'),
      prog('a', NOW + HOUR, NOW + 2 * HOUR, 'a-after'),
      prog('b', NOW - 2 * HOUR, NOW - HOUR, 'b-ended'),
      prog('c', NOW + HOUR, NOW + 2 * HOUR, 'c-future'),
    ]);
    expect(q.nowFor(P, [1, 2, 3, 4], NOW)).toEqual(new Map([[1, { title: 'a-now', startSec: NOW - HOUR, stopSec: NOW + HOUR }]]));
    // A gap between two programmes is not airing; the stop is exclusive and the start inclusive.
    expect(q.nowFor(P, [1], NOW + HOUR).get(1)?.title).toBe('a-after');
    expect(q.nowFor(P, [1], NOW - 3 * HOUR).size).toBe(0);
    expect(q.nowFor(P, [], NOW).size).toBe(0);
  });

  test('nowFor ignores rows of a generation that is not current', () => {
    item(1, 'a');
    seed([prog('a', NOW - HOUR, NOW + HOUR, 'old')]);
    const g = store.beginGeneration(P, 0);
    store.insertProgrammes(P, g, [prog('a', NOW - HOUR, NOW + HOUR, 'uncommitted')]);
    expect(q.nowFor(P, [1], NOW).get(1)?.title).toBe('old');
    seed([prog('a', NOW - HOUR, NOW + HOUR, 'new')]);
    expect(q.nowFor(P, [1], NOW).get(1)?.title).toBe('new');
  });

  test('with no guide every query is empty', () => {
    item(1, 'a');
    expect(q.nowFor(P, [1], NOW).size).toBe(0);
    expect(q.whatsOn({ providerId: P, order: [1], mode: 'now', nowSec: NOW, cursor: null, limit: 10 })).toEqual({ items: [], nextCursor: null });
    expect(q.programmesFor(P, [1], 0, NOW).size).toBe(0);
    expect(q.range(P)).toBeNull();
    expect(q.sources(P, '', 10)).toEqual([]);
  });

  test("what's on lists a programme once across channel versions", () => {
    item(10, 'a');
    item(11, 'a');
    item(12, 'b');
    seed([prog('a', NOW - HOUR, NOW + HOUR), prog('b', NOW - HOUR, NOW + HOUR)]);
    const res = q.whatsOn({ providerId: P, order: [11, 10, 12], mode: 'now', nowSec: NOW, cursor: null, limit: 10 });
    expect(res.items.map((i) => i.itemId)).toEqual([11, 12]);
    expect(res.nextCursor).toBeNull();
  });

  test('range mode is half-open and ordered by start', () => {
    item(1, 'a');
    item(2, 'b');
    seed([
      prog('a', 1000, 1100, 'at-to'),
      prog('b', 500, 600, 'at-from'),
      prog('a', 700, 800, 'middle'),
      prog('b', 499, 600, 'before'),
    ]);
    const res = q.whatsOn({ providerId: P, order: [1, 2], mode: 'range', fromSec: 500, toSec: 1000, nowSec: NOW, cursor: null, limit: 10 });
    expect(res.items.map((i) => i.programme.title)).toEqual(['at-from', 'middle']);
  });

  test('past mode lists catch-up programmes only', () => {
    item(1, 'a', 2); // two days of archive
    item(2, 'b', null); // no archive
    item(3, 'c', 0);
    const day = 86_400;
    seed([
      prog('a', NOW - 3 * day, NOW - 3 * day + HOUR, 'too-old'),
      prog('a', NOW - day, NOW - day + HOUR, 'yesterday'),
      prog('a', NOW - 2 * HOUR, NOW - HOUR, 'recent'),
      prog('a', NOW - HOUR, NOW + HOUR, 'airing'),
      prog('b', NOW - 2 * HOUR, NOW - HOUR, 'no-archive'),
      prog('c', NOW - 2 * HOUR, NOW - HOUR, 'zero-archive'),
    ]);
    const res = q.whatsOn({ providerId: P, order: [1, 2, 3], mode: 'past', nowSec: NOW, cursor: null, limit: 10 });
    expect(res.items.map((i) => i.programme.title)).toEqual(['recent', 'yesterday']);
    const from = q.whatsOn({ providerId: P, order: [1], mode: 'past', fromSec: NOW - 3 * HOUR, nowSec: NOW, cursor: null, limit: 10 });
    expect(from.items.map((i) => i.programme.title)).toEqual(['recent']);
  });

  test('paging walks every entry once', () => {
    for (let i = 1; i <= 120; i++) item(i, `k${i}`, 1);
    const rows: ProgrammeRow[] = [];
    // Many entries share a start, so the position and id tie-breaks are exercised.
    for (let i = 1; i <= 120; i++) rows.push(prog(`k${i}`, NOW - 2 * HOUR - (i % 7) * 60, NOW - HOUR, `p${i}`));
    seed(rows);
    const order = Array.from({ length: 120 }, (_, i) => 120 - i);
    for (const mode of ['range', 'past'] as const) {
      const seen: number[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const res: ReturnType<GuideQueries['whatsOn']> = q.whatsOn({
          providerId: P, order, mode, fromSec: NOW - 3 * HOUR, toSec: NOW, nowSec: NOW, cursor, limit: 50,
        });
        sizes.push(res.items.length);
        seen.push(...res.items.map((i) => i.itemId));
        cursor = res.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([50, 50, 20]);
      expect(new Set(seen).size).toBe(120);
    }
    // 'now' pages by offset.
    seed(Array.from({ length: 120 }, (_, i) => prog(`k${i + 1}`, NOW - HOUR, NOW + HOUR)));
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res: ReturnType<GuideQueries['whatsOn']> = q.whatsOn({ providerId: P, order, mode: 'now', nowSec: NOW, cursor, limit: 50 });
      sizes.push(res.items.length);
      cursor = res.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([50, 50, 20]);
  });

  test('an invalid cursor is the first page', () => {
    item(1, 'a');
    seed([prog('a', NOW - HOUR, NOW + HOUR)]);
    for (const cursor of ['!!!', Buffer.from('{"x":1}').toString('base64url'), Buffer.from('[1,2]').toString('base64url')]) {
      expect(q.whatsOn({ providerId: P, order: [1], mode: 'now', nowSec: NOW, cursor, limit: 10 }).items).toHaveLength(1);
    }
  });

  test('programmesFor includes programmes that overlap the window edges', () => {
    item(1, 'a');
    item(2, 'a');
    seed([
      prog('a', 0, 100, 'ends-at-from'),
      prog('a', 90, 200, 'overlaps-start'),
      prog('a', 200, 300, 'inside'),
      prog('a', 290, 400, 'overlaps-end'),
      prog('a', 300, 400, 'starts-at-to'),
    ]);
    const res = q.programmesFor(P, [1, 2], 100, 300);
    const titles = ['overlaps-start', 'inside', 'overlaps-end'];
    expect(res.get(1)!.map((p) => p.title)).toEqual(titles);
    expect(res.get(2)!.map((p) => p.title)).toEqual(titles);
  });

  test('linkedItemIds and range', () => {
    item(1, 'a');
    item(2, null);
    seed([prog('a', 50, 100), prog('a', 100, 900)]);
    expect(q.linkedItemIds(P, [1, 2])).toEqual(new Set([1]));
    expect(q.range(P)).toEqual({ fromSec: 50, toSec: 900 });
  });

  test('sources escapes LIKE wildcards', () => {
    seed([], [
      { key: 'a', name: '100% Music' },
      { key: 'b', name: 'BBC One', names: ['BBC One', 'BBC 1'] },
      { key: 'c', name: 'Under_score' },
      { key: 'd', name: 'Other' },
    ]);
    expect(q.sources(P, '%', 10).map((c) => c.key)).toEqual(['a']);
    expect(q.sources(P, '_', 10).map((c) => c.key)).toEqual(['c']);
    expect(q.sources(P, 'bbc 1', 10).map((c) => c.key)).toEqual(['b']);
    expect(q.sources(P, '', 2).map((c) => c.name)).toEqual(['100% Music', 'BBC One']);
  });
  test('the guide is read from the current generation only, by every query', () => {
    item(1, 'a', 3);
    item(2, 'orphan', 3);
    // Generation 1 holds rows that the current generation 2 does not.
    seed(
      [prog('a', NOW + HOUR, NOW + 2 * HOUR, 'old-range'), prog('a', NOW - 2 * HOUR, NOW - HOUR, 'old-past'), prog('orphan', 10, 20, 'old-orphan'),
        prog('a', NOW + 8 * HOUR, NOW + 9 * HOUR, 'old-late')],
      [{ key: 'old-chan', name: 'Old' }],
    );
    seed([prog('a', NOW + 3 * HOUR, NOW + 4 * HOUR, 'new-range'), prog('a', NOW - 4 * HOUR, NOW - 3 * HOUR, 'new-past')], [{ key: 'new-chan', name: 'New' }]);
    const base = { providerId: P, order: [1], nowSec: NOW, cursor: null, limit: 10 };
    expect(q.whatsOn({ ...base, mode: 'range', fromSec: NOW, toSec: NOW + 10 * HOUR }).items.map((i) => i.programme.title)).toEqual(['new-range']);
    expect(q.whatsOn({ ...base, mode: 'past' }).items.map((i) => i.programme.title)).toEqual(['new-past']);
    expect(q.programmesFor(P, [1], 0, NOW + 10 * HOUR).get(1)!.map((p) => p.title)).toEqual(['new-past', 'new-range']);
    expect(q.range(P)).toEqual({ fromSec: NOW - 4 * HOUR, toSec: NOW + 4 * HOUR });
    expect(q.sources(P, '', 10).map((c) => c.key)).toEqual(['new-chan']);
    expect(q.linkedItemIds(P, [1, 2])).toEqual(new Set([1]));
  });

  test('linkedItemIds needs a guide and programmes on the channel', () => {
    item(1, 'a');
    item(2, 'empty');
    expect(q.linkedItemIds(P, [1, 2])).toEqual(new Set());
    seed([prog('a', 0, 10)]);
    expect(q.linkedItemIds(P, [1, 2])).toEqual(new Set([1]));
  });

  test('past mode includes the boundaries of the archive window', () => {
    const day = 86_400;
    item(1, 'a', 2);
    seed([
      prog('a', NOW - 2 * day, NOW - 2 * day + HOUR, 'at-window-edge'),
      prog('a', NOW - 2 * day - 1, NOW - 2 * day + HOUR, 'just-outside'),
      prog('a', NOW - HOUR, NOW, 'stops-now'),
      prog('a', NOW - HOUR + 1, NOW + 1, 'stops-after-now'),
    ]);
    const res = q.whatsOn({ providerId: P, order: [1], mode: 'past', nowSec: NOW, cursor: null, limit: 10 });
    expect(res.items.map((i) => i.programme.title)).toEqual(['stops-now', 'at-window-edge']);
  });

  test('past mode lets an item with an archive stand in for a version without one', () => {
    item(1, 'a', null); // HD, first in order, no archive
    item(2, 'a', 2); // SD, archive
    seed([prog('a', NOW - 2 * HOUR, NOW - HOUR, 'earlier')]);
    const res = q.whatsOn({ providerId: P, order: [1, 2], mode: 'past', nowSec: NOW, cursor: null, limit: 10 });
    expect(res.items.map((i) => i.itemId)).toEqual([2]);
  });

  test('paging with an exact multiple of the limit ends cleanly, with distinct entries', () => {
    for (let i = 1; i <= 100; i++) item(i, `k${i}`, 1);
    seed(Array.from({ length: 100 }, (_, i) => prog(`k${i + 1}`, NOW - HOUR + (i % 3), NOW + 2 * HOUR, `p${i}`)));
    const order = Array.from({ length: 100 }, (_, i) => i + 1);
    for (const mode of ['now', 'range'] as const) {
      const ids: number[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const res: ReturnType<GuideQueries['whatsOn']> = q.whatsOn({
          providerId: P, order, mode, fromSec: NOW - 2 * HOUR, toSec: NOW + HOUR, nowSec: NOW, cursor, limit: 50,
        });
        sizes.push(res.items.length);
        ids.push(...res.items.map((i) => i.itemId));
        cursor = res.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([50, 50]);
      expect(new Set(ids).size).toBe(100);
    }
  });

  test('queries stay fast over a large guide', () => {
    const N = 2000;
    for (let i = 1; i <= N; i++) item(i, `k${i}`, 1);
    const g = store.beginGeneration(P, 0);
    const rows: ProgrammeRow[] = [];
    for (let c = 1; c <= N; c++) for (let j = 0; j < 25; j++) rows.push(prog(`k${c}`, NOW - 6 * HOUR + j * 1800, NOW - 6 * HOUR + (j + 1) * 1800));
    store.insertProgrammes(P, g, rows);
    store.commitGeneration(P, g, { fetchedAt: 0, source: 'xmltv' });
    const ids = Array.from({ length: N }, (_, i) => i + 1);
    const time = (f: () => unknown): number => {
      f();
      const runs = Array.from({ length: 5 }, () => {
        const s = performance.now();
        f();
        return performance.now() - s;
      });
      return runs.sort((a, b) => a - b)[2]!; // the median, so one GC pause cannot fail the guard
    };
    expect(time(() => q.whatsOn({ providerId: P, order: ids, mode: 'now', nowSec: NOW, cursor: null, limit: 500 }))).toBeLessThan(50);
    expect(time(() => q.programmesFor(P, ids.slice(0, 30), NOW, NOW + 6 * HOUR))).toBeLessThan(50);
  });
});
