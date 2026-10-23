import type { Kind, SyncResult } from '@tv/shared';
import type { Db } from '../db/db.ts';
import type { RawItem, XtreamClient } from '../providers/xtream/client.ts';

export type { SyncResult } from '@tv/shared';

const ALL_KINDS: Kind[] = ['live', 'movie', 'series'];
const BATCH = 2000;
const NONE_ID = '__none__';

type Statements = ReturnType<typeof prepare>;

function prepare(db: Db) {
  return {
    upsertCategory: db.prepare(
      `INSERT INTO categories (provider_id, kind, remote_id, name, position, seen_at)
       VALUES (@providerId, @kind, @remoteId, @name, @position, @seenAt)
       ON CONFLICT (provider_id, kind, remote_id)
       DO UPDATE SET name = excluded.name, position = excluded.position, seen_at = excluded.seen_at
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
    clearLinks: db.prepare('DELETE FROM item_categories WHERE item_id = ?'),
    link: db.prepare(
      'INSERT OR IGNORE INTO item_categories (category_id, item_id, position) VALUES (?, ?, ?)',
    ),
    deleteItems: db.prepare('DELETE FROM items WHERE provider_id = ? AND kind = ? AND seen_at < ?'),
    deleteCategories: db.prepare('DELETE FROM categories WHERE provider_id = ? AND kind = ? AND seen_at < ?'),
  };
}

async function syncKind(
  db: Db,
  st: Statements,
  client: XtreamClient,
  providerId: number,
  kind: Kind,
  startedAt: number,
): Promise<SyncResult[Kind]> {
  // Categories first: fetched fully, small, and needed to resolve item links.
  const categoryIds = new Map<string, number>();
  const rawCategories = await client.getCategories(kind);
  let categoryCount = 0;
  db.transaction(() => {
    rawCategories.forEach((c, position) => {
      const id = st.upsertCategory.pluck().get({
        providerId, kind, remoteId: c.remoteId, name: c.name, position, seenAt: startedAt,
      }) as number;
      categoryIds.set(c.remoteId, id);
      categoryCount++;
    });
  })();

  let noneId: number | null = null;
  const uncategorised = (): number => {
    if (noneId === null) {
      noneId = st.upsertCategory.pluck().get({
        providerId, kind, remoteId: NONE_ID, name: 'Uncategorised', position: rawCategories.length, seenAt: startedAt,
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
      st.clearLinks.run(itemId);
      const position = it.position ?? firstIndex + i;
      let linked = 0;
      for (const remote of it.categoryRemoteIds) {
        const categoryId = categoryIds.get(remote);
        if (categoryId === undefined) continue;
        st.link.run(categoryId, itemId, position);
        linked++;
      }
      if (linked === 0) st.link.run(uncategorised(), itemId, position);
    });
  });

  for await (const item of client.streamItems(kind)) {
    batch.push(item);
    arrival++;
    if (batch.length >= BATCH) {
      flush(batch, arrival - batch.length);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    flush(batch, arrival - batch.length);
    total += batch.length;
  }

  // Only a fully streamed kind may remove anything.
  const removed = db.transaction(() => {
    const n = st.deleteItems.run(providerId, kind, startedAt).changes;
    st.deleteCategories.run(providerId, kind, startedAt);
    return n;
  })();

  return { categories: categoryCount, items: total, removed };
}

export async function syncCatalogue(deps: {
  db: Db;
  client: XtreamClient;
  providerId: number;
  kinds?: Kind[];
  now?: () => number;
}): Promise<SyncResult> {
  const { db, client, providerId } = deps;
  const now = deps.now ?? Date.now;
  const kinds = deps.kinds ?? ALL_KINDS;
  const st = prepare(db);
  const result: SyncResult = {
    live: { categories: 0, items: 0, removed: 0 },
    movie: { categories: 0, items: 0, removed: 0 },
    series: { categories: 0, items: 0, removed: 0 },
  };
  for (const kind of ALL_KINDS) {
    if (!kinds.includes(kind)) continue;
    result[kind] = await syncKind(db, st, client, providerId, kind, now());
  }
  return result;
}
