import type { Kind, SyncResult } from '@tv/shared';
import type { Db } from '../db/db.ts';
import { detectTagStyle, tagOf } from '../curation/tags.ts';
import { silentLog } from '../util/log.ts';
import type { Log } from '../util/log.ts';
import type { RawItem, XtreamClient } from '../providers/xtream/client.ts';

export type { SyncResult } from '@tv/shared';

const ALL_KINDS: Kind[] = ['live', 'movie', 'series'];
const BATCH = 2000;
const PRUNE_CHUNK = 1000;
const NONE_ID = '__none__';

type Statements = ReturnType<typeof prepare>;

function prepare(db: Db) {
  return {
    upsertCategory: db.prepare(
      `INSERT INTO categories (provider_id, kind, remote_id, name, position, seen_at, tag, first_seen_at)
       VALUES (@providerId, @kind, @remoteId, @name, @position, @seenAt, @tag, @seenAt)
       ON CONFLICT (provider_id, kind, remote_id)
       DO UPDATE SET name = excluded.name, position = excluded.position, seen_at = excluded.seen_at, tag = excluded.tag,
         -- SET expressions read the row as it was, so categories.tag here is the old tag.
         tag_changed_at = CASE WHEN categories.tag IS NOT excluded.tag THEN excluded.seen_at ELSE categories.tag_changed_at END
       RETURNING id`,
    ),
    upsertItem: db.prepare(
      `INSERT INTO items (provider_id, kind, remote_id, name, position, logo_url, container_ext,
                          epg_channel_id, catchup_days, added_at, rating, year, seen_at)
       VALUES (@providerId, @kind, @remoteId, @name, @position, @logoUrl, @containerExt,
               @epgChannelId, @catchupDays, @addedAt, @rating, @year, @seenAt)
       ON CONFLICT (provider_id, kind, remote_id) DO UPDATE SET
         name = excluded.name, position = excluded.position, logo_url = excluded.logo_url,
         container_ext = excluded.container_ext, epg_channel_id = excluded.epg_channel_id,
         catchup_days = excluded.catchup_days, added_at = excluded.added_at,
         rating = excluded.rating, year = excluded.year, seen_at = excluded.seen_at
       RETURNING id`,
    ),
    link: db.prepare(
      `INSERT INTO item_categories (category_id, item_id, position, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (category_id, item_id) DO UPDATE SET position = excluded.position, seen_at = excluded.seen_at`,
    ),
    upsertStyle: db.prepare(
      `INSERT INTO catalogue_styles (provider_id, kind, style, pattern) VALUES (?, ?, ?, ?)
       ON CONFLICT (provider_id, kind) DO UPDATE SET style = excluded.style, pattern = excluded.pattern`,
    ),
    countItems: db.prepare('SELECT COUNT(*) FROM items WHERE provider_id = ? AND kind = ?').pluck(),
    // The provider's own categories: Uncategorised is ours.
    countCategories: db
      .prepare(`SELECT COUNT(*) FROM categories WHERE provider_id = ? AND kind = ? AND remote_id <> '${NONE_ID}'`)
      .pluck(),
    deleteLinks: db.prepare(
      `DELETE FROM item_categories WHERE rowid IN (
         SELECT ic.rowid FROM item_categories ic JOIN categories c ON c.id = ic.category_id
         WHERE c.provider_id = ? AND c.kind = ? AND ic.seen_at < ? LIMIT ${PRUNE_CHUNK})`,
    ),
    deleteItems: db.prepare(
      `DELETE FROM items WHERE id IN (
         SELECT id FROM items WHERE provider_id = ? AND kind = ? AND seen_at < ? LIMIT ${PRUNE_CHUNK})`,
    ),
    deleteCategories: db.prepare(
      `DELETE FROM categories WHERE id IN (
         SELECT id FROM categories WHERE provider_id = ? AND kind = ? AND seen_at < ? LIMIT ${PRUNE_CHUNK})`,
    ),
  };
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Runs a bounded delete until it removes less than a full chunk, yielding to the event loop between chunks. */
async function deleteInChunks(db: Db, stmt: Statements['deleteItems'], args: [number, Kind, number]): Promise<number> {
  const once = db.transaction(() => stmt.run(...args).changes);
  let total = 0;
  for (;;) {
    const n = once();
    total += n;
    if (n < PRUNE_CHUNK) return total;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function syncKind(
  db: Db,
  st: Statements,
  log: Log,
  client: XtreamClient,
  providerId: number,
  kind: Kind,
  startedAt: number,
): Promise<SyncResult[Kind]> {
  // Categories first: fetched fully, small, and needed to resolve item links.
  const categoryIds = new Map<string, number>();
  const rawCategories = await client.getCategories(kind);
  const itemsBefore = st.countItems.get(providerId, kind) as number;
  const categoriesBefore = st.countCategories.get(providerId, kind) as number;
  // An empty category list for a kind that had categories is a provider hiccup, like an empty item list: the kind's
  // tag style, categories, tags and links stay as they are, and nothing is filed under Uncategorised.
  const categoriesMissing = rawCategories.length === 0 && categoriesBefore > 0;

  // A tag only counts when at least two categories share it (P2-R4); a lone match is just a word.
  const names = rawCategories.map((c) => c.name.trim());
  const { style, pattern } = detectTagStyle(names);
  const tagCounts = new Map<string, number>();
  for (const n of names) {
    const t = tagOf(n, pattern);
    if (t !== null) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const tagFor = (name: string): string | null => {
    const t = tagOf(name, pattern);
    return t !== null && (tagCounts.get(t) ?? 0) >= 2 ? t : null;
  };

  let categoryCount = 0;
  db.transaction(() => {
    if (!categoriesMissing) st.upsertStyle.run(providerId, kind, style, pattern);
    rawCategories.forEach((c, position) => {
      const id = st.upsertCategory.pluck().get({
        providerId, kind, remoteId: c.remoteId, name: c.name, position, seenAt: startedAt, tag: tagFor(c.name.trim()),
      }) as number;
      categoryIds.set(c.remoteId, id);
      categoryCount++;
    });
  })();

  let noneId: number | null = null;
  const uncategorised = (): number => {
    if (noneId === null) {
      noneId = st.upsertCategory.pluck().get({
        providerId, kind, remoteId: NONE_ID, name: 'Uncategorised', position: rawCategories.length, seenAt: startedAt, tag: null,
      }) as number;
      categoryCount++;
    }
    return noneId;
  };

  let batch: RawItem[] = [];
  let arrival = 0;
  let total = 0;

  const flush = db.transaction((rows: RawItem[], firstIndex: number) => {
    rows.forEach((it, i) => {
      const itemId = st.upsertItem.pluck().get({
        providerId, kind, remoteId: it.remoteId, name: it.name, position: it.position,
        logoUrl: it.logoUrl, containerExt: it.containerExt, epgChannelId: it.epgChannelId,
        catchupDays: it.catchupDays, addedAt: it.addedAt, rating: it.rating, year: it.year,
        seenAt: startedAt,
      }) as number;
      const position = it.position ?? firstIndex + i;
      let linked = 0;
      for (const remote of it.categoryRemoteIds) {
        const categoryId = categoryIds.get(remote);
        if (categoryId === undefined) continue;
        st.link.run(categoryId, itemId, position, startedAt);
        linked++;
      }
      if (linked === 0 && !categoriesMissing) st.link.run(uncategorised(), itemId, position, startedAt);
    });
  });

  for await (const item of client.streamItems(kind)) {
    batch.push(item);
    arrival++;
    if (batch.length >= BATCH) {
      flush(batch, arrival - batch.length);
      total += batch.length;
      batch = [];
      // A parser running ahead of us hands items over as microtasks; without this the loop never yields.
      await yieldToEventLoop();
    }
  }
  if (batch.length > 0) {
    flush(batch, arrival - batch.length);
    total += batch.length;
  }

  // Only a fully streamed kind may remove anything, and an empty answer for a kind that had data is
  // treated as a provider hiccup rather than a request to delete everything.
  if ((total === 0 && itemsBefore > 0) || categoriesMissing) {
    log.warn(
      { providerId, kind, items: total, categories: rawCategories.length, itemsBefore, categoriesBefore },
      'provider returned an empty list; pruning skipped',
    );
    return { categories: categoryCount, items: total, removed: 0, skippedPrune: true };
  }

  await deleteInChunks(db, st.deleteLinks, [providerId, kind, startedAt]);
  const removed = await deleteInChunks(db, st.deleteItems, [providerId, kind, startedAt]);
  await deleteInChunks(db, st.deleteCategories, [providerId, kind, startedAt]);

  return { categories: categoryCount, items: total, removed, skippedPrune: false };
}

export async function syncCatalogue(deps: {
  db: Db;
  client: XtreamClient;
  providerId: number;
  kinds?: Kind[];
  now?: () => number;
  log?: Log;
}): Promise<SyncResult> {
  const { db, client, providerId } = deps;
  const now = deps.now ?? Date.now;
  const kinds = deps.kinds ?? ALL_KINDS;
  const log = deps.log ?? silentLog;
  const st = prepare(db);
  const result: SyncResult = {
    live: { categories: 0, items: 0, removed: 0, skippedPrune: false },
    movie: { categories: 0, items: 0, removed: 0, skippedPrune: false },
    series: { categories: 0, items: 0, removed: 0, skippedPrune: false },
  };
  for (const kind of ALL_KINDS) {
    if (!kinds.includes(kind)) continue;
    result[kind] = await syncKind(db, st, log, client, providerId, kind, now());
  }
  return result;
}
