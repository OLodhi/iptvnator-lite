import type { NowProgramme, Programme } from '@tv/shared';
import type { Db } from '../db/db.ts';

export type WhatsOnQuery = {
  providerId: number;
  /** Item ids in display order; an earlier position wins when several items share a channel. */
  order: number[];
  mode: 'now' | 'range' | 'past';
  fromSec?: number;
  toSec?: number;
  nowSec: number;
  cursor: string | null;
  limit: number;
};

export interface GuideQueries {
  /** The programme airing at `nowSec` on each item's linked channel; items with none are absent. */
  nowFor(providerId: number, itemIds: number[], nowSec: number): Map<number, NowProgramme>;
  whatsOn(q: WhatsOnQuery): { items: { itemId: number; programme: Programme }[]; nextCursor: string | null };
  /** Programmes overlapping [fromSec, toSec) per item, by start. */
  programmesFor(providerId: number, itemIds: number[], fromSec: number, toSec: number): Map<number, Programme[]>;
  linkedItemIds(providerId: number, itemIds: number[]): Set<number>;
  /** Earliest start and latest stop of the current guide; null when there is none. */
  range(providerId: number): { fromSec: number; toSec: number } | null;
  sources(providerId: number, q: string, limit: number): { key: string; name: string }[];
}

const MAX_SOURCES = 50;
const MAX_PAGE = 500;
const DAY = 86_400;

type Row = {
  itemId: number;
  id: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  start: number;
  stop: number;
  pos: number;
};

const toProgramme = (r: Row): Programme => ({
  id: r.id,
  title: r.title,
  subtitle: r.subtitle,
  description: r.description,
  category: r.category,
  startSec: r.start,
  stopSec: r.stop,
});

const escapeLike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);
const encode = (tuple: number[]): string => Buffer.from(JSON.stringify(tuple)).toString('base64url');
/** A cursor that is not one of ours is the first page, never an error. */
function decode(cursor: string | null, length: number): number[] | null {
  if (!cursor) return null;
  try {
    const t: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(t) && t.length === length && t.every((n) => Number.isSafeInteger(n)) ? (t as number[]) : null;
  } catch {
    return null;
  }
}

// One row per channel: of several items on one channel the earliest in `order` wins. Programmes are then read per
// channel through programmes_slot (provider, generation, channel, start), never by scanning the table.
const CHANNELS = `
  ord AS (SELECT CAST(j.value AS INTEGER) AS item_id, CAST(j.key AS INTEGER) AS pos FROM json_each(@order) j),
  chan AS (SELECT gl.channel_key AS ck, ord.item_id AS item_id, MIN(ord.pos) AS pos
             FROM ord JOIN guide_links gl ON gl.item_id = ord.item_id AND gl.provider_id = @providerId
            GROUP BY gl.channel_key)`;
const COLUMNS = `p.id AS id, p.title AS title, p.subtitle AS subtitle, p.description AS description,
  p.category AS category, p.start AS start, p.stop AS stop, chan.item_id AS itemId, chan.pos AS pos`;
// The latest programme starting at or before now on a channel; it is airing only if it has not stopped.
const LATEST = (channel: string) => `(SELECT s.id FROM programmes s
    WHERE s.provider_id = @providerId AND s.generation = @generation AND s.channel_key = ${channel} AND s.start <= @now
    ORDER BY s.start DESC LIMIT 1)`;

export function createGuideQueries(db: Db): GuideQueries {
  // No guide_state row means no guide: generation 0 holds nothing.
  const generationOf = db.prepare('SELECT generation FROM guide_state WHERE provider_id = ?').pluck();
  const generation = (providerId: number): number => (generationOf.get(providerId) as number | undefined) ?? 0;

  const nowRows = db.prepare(
    `SELECT CAST(j.value AS INTEGER) AS itemId, p.title AS title, p.start AS start, p.stop AS stop
       FROM json_each(@ids) j
       JOIN guide_links gl ON gl.item_id = j.value AND gl.provider_id = @providerId
       JOIN programmes p ON p.id = ${LATEST('gl.channel_key')}
      WHERE p.stop > @now`,
  );
  const airing = db.prepare(
    `WITH ${CHANNELS}
     SELECT ${COLUMNS} FROM chan
       JOIN programmes p ON p.id = ${LATEST('chan.ck')}
      WHERE p.stop > @now
      ORDER BY chan.pos LIMIT @limit OFFSET @offset`,
  );
  const KEYSET = {
    asc: `(@hasCursor = 0 OR p.start > @cStart OR (p.start = @cStart AND (chan.pos > @cPos OR (chan.pos = @cPos AND p.id > @cId))))`,
    desc: `(@hasCursor = 0 OR p.start < @cStart OR (p.start = @cStart AND (chan.pos > @cPos OR (chan.pos = @cPos AND p.id > @cId))))`,
  };
  const inRange = db.prepare(
    `WITH ${CHANNELS}
     SELECT ${COLUMNS} FROM chan
       JOIN programmes p ON p.provider_id = @providerId AND p.generation = @generation AND p.channel_key = chan.ck
                        AND p.start >= @from AND p.start < @to
      WHERE ${KEYSET.asc}
      ORDER BY p.start, chan.pos, p.id LIMIT @limit`,
  );
  // Catch-up is the channel's archive window: the programme has ended and started within `catchup_days`.
  const past = db.prepare(
    `WITH ${CHANNELS}
     SELECT ${COLUMNS} FROM chan
       JOIN items ON items.id = chan.item_id AND items.catchup_days > 0
       JOIN programmes p ON p.provider_id = @providerId AND p.generation = @generation AND p.channel_key = chan.ck
                        AND p.start >= @from AND p.start >= @now - items.catchup_days * ${DAY} AND p.stop <= @now
      WHERE ${KEYSET.desc}
      ORDER BY p.start DESC, chan.pos, p.id LIMIT @limit`,
  );
  const overlapping = db.prepare(
    `SELECT CAST(j.value AS INTEGER) AS itemId, p.id AS id, p.title AS title, p.subtitle AS subtitle,
            p.description AS description, p.category AS category, p.start AS start, p.stop AS stop
       FROM json_each(@ids) j
       JOIN guide_links gl ON gl.item_id = j.value AND gl.provider_id = @providerId
       JOIN programmes p ON p.provider_id = @providerId AND p.generation = @generation AND p.channel_key = gl.channel_key
                        AND p.start < @to AND p.stop > @from
      ORDER BY p.start`,
  );
  const linked = db
    .prepare(`SELECT gl.item_id FROM json_each(@ids) j JOIN guide_links gl ON gl.item_id = j.value AND gl.provider_id = @providerId`)
    .pluck();
  const bounds = db.prepare('SELECT MIN(start) AS fromSec, MAX(stop) AS toSec FROM programmes WHERE provider_id = ? AND generation = ?');
  const channels = db.prepare(
    `SELECT key, name FROM guide_channels
      WHERE provider_id = @providerId AND generation = @generation
        AND (@pattern IS NULL OR key LIKE @pattern ESCAPE '\\' OR name LIKE @pattern ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM json_each(names) n WHERE n.value LIKE @pattern ESCAPE '\\'))
      ORDER BY name, key LIMIT @limit`,
  );

  return {
    nowFor(providerId, itemIds, nowSec) {
      const out = new Map<number, NowProgramme>();
      const gen = generation(providerId);
      if (gen === 0 || itemIds.length === 0) return out;
      const rows = nowRows.all({ ids: JSON.stringify(itemIds), providerId, generation: gen, now: nowSec }) as {
        itemId: number;
        title: string;
        start: number;
        stop: number;
      }[];
      for (const r of rows) out.set(r.itemId, { title: r.title, startSec: r.start, stopSec: r.stop });
      return out;
    },

    whatsOn(q) {
      const gen = generation(q.providerId);
      const limit = Math.max(1, Math.min(q.limit, MAX_PAGE));
      if (gen === 0 || q.order.length === 0) return { items: [], nextCursor: null };
      // One extra row says whether another page follows.
      const common = { order: JSON.stringify(q.order), providerId: q.providerId, generation: gen, now: q.nowSec, limit: limit + 1 };
      let rows: Row[];
      let cursorOf: (last: Row) => string;
      if (q.mode === 'now') {
        const offset = decode(q.cursor, 1)?.[0] ?? 0;
        rows = airing.all({ ...common, offset }) as Row[];
        cursorOf = () => encode([offset + limit]);
      } else {
        const c = decode(q.cursor, 3);
        const keyset = { hasCursor: c ? 1 : 0, cStart: c?.[0] ?? 0, cPos: c?.[1] ?? 0, cId: c?.[2] ?? 0 };
        if (q.mode === 'range') {
          const from = q.fromSec ?? q.nowSec;
          rows = inRange.all({ ...common, ...keyset, from, to: q.toSec ?? from + DAY }) as Row[];
        } else {
          rows = past.all({ ...common, ...keyset, from: q.fromSec ?? 0 }) as Row[];
        }
        cursorOf = (last) => encode([last.start, last.pos, last.id]);
      }
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      return {
        items: page.map((r) => ({ itemId: r.itemId, programme: toProgramme(r) })),
        nextCursor: more ? cursorOf(page[page.length - 1]!) : null,
      };
    },

    programmesFor(providerId, itemIds, fromSec, toSec) {
      const out = new Map<number, Programme[]>();
      const gen = generation(providerId);
      if (gen === 0 || itemIds.length === 0) return out;
      const rows = overlapping.all({ ids: JSON.stringify(itemIds), providerId, generation: gen, from: fromSec, to: toSec }) as Row[];
      for (const r of rows) {
        const list = out.get(r.itemId);
        if (list) list.push(toProgramme(r));
        else out.set(r.itemId, [toProgramme(r)]);
      }
      return out;
    },

    linkedItemIds(providerId, itemIds) {
      if (itemIds.length === 0) return new Set();
      return new Set(linked.all({ ids: JSON.stringify(itemIds), providerId }) as number[]);
    },

    range(providerId) {
      const gen = generation(providerId);
      if (gen === 0) return null;
      const r = bounds.get(providerId, gen) as { fromSec: number | null; toSec: number | null };
      return r.fromSec === null || r.toSec === null ? null : { fromSec: r.fromSec, toSec: r.toSec };
    },

    sources(providerId, q, limit) {
      const gen = generation(providerId);
      if (gen === 0) return [];
      const text = q.replace(/\p{Cc}/gu, '').trim();
      return channels.all({
        providerId,
        generation: gen,
        pattern: text === '' ? null : `%${escapeLike(text)}%`,
        limit: Math.max(1, Math.min(limit, MAX_SOURCES)),
      }) as { key: string; name: string }[];
    },
  };
}
