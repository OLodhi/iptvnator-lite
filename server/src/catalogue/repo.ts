import type { CatalogItem, Category, Kind, Page } from '@tv/shared';
import type { Db } from '../db/db.ts';

export type ItemDetail = CatalogItem & { remoteId: string; containerExt: string | null };

export interface CatalogueRepo {
  listCategories(providerId: number, kind: Kind): Category[];
  /** Returns undefined when the cursor is malformed. */
  listItems(categoryId: number, cursor: string | null, limit: number): Page<CatalogItem> | undefined;
  getItem(id: number): ItemDetail | undefined;
}

type ItemRow = CatalogItem & { position?: number };

const COLUMNS = `items.id AS id, items.provider_id AS providerId, items.kind AS kind, items.name AS name,
  items.logo_url AS logoUrl, items.catchup_days AS catchupDays, items.year AS year, items.rating AS rating`;

const toItem = (r: ItemRow): CatalogItem => ({
  id: r.id,
  providerId: r.providerId,
  kind: r.kind,
  name: r.name,
  logoUrl: r.logoUrl,
  catchupDays: r.catchupDays,
  year: r.year,
  rating: r.rating,
});

const encodeCursor = (position: number, itemId: number): string =>
  Buffer.from(`${position}:${itemId}`).toString('base64url');

function decodeCursor(cursor: string): { position: number; itemId: number } | undefined {
  const m = /^(-?\d+):(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return m ? { position: Number(m[1]), itemId: Number(m[2]) } : undefined;
}

export function createCatalogueRepo(db: Db): CatalogueRepo {
  const categories = db.prepare(
    `SELECT c.id AS id, c.name AS name,
            (SELECT COUNT(*) FROM item_categories ic WHERE ic.category_id = c.id) AS itemCount
       FROM categories c WHERE c.provider_id = ? AND c.kind = ?
      ORDER BY c.position, c.id`,
  );
  const firstPage = db.prepare(
    `SELECT ${COLUMNS}, ic.position AS position
       FROM item_categories ic JOIN items ON items.id = ic.item_id
      WHERE ic.category_id = @categoryId
      ORDER BY ic.position, ic.item_id LIMIT @limit`,
  );
  const nextPage = db.prepare(
    `SELECT ${COLUMNS}, ic.position AS position
       FROM item_categories ic JOIN items ON items.id = ic.item_id
      WHERE ic.category_id = @categoryId
        AND (ic.position > @position OR (ic.position = @position AND ic.item_id > @itemId))
      ORDER BY ic.position, ic.item_id LIMIT @limit`,
  );
  const one = db.prepare(
    `SELECT ${COLUMNS}, items.remote_id AS remoteId, items.container_ext AS containerExt FROM items WHERE items.id = ?`,
  );

  return {
    listCategories: (providerId, kind) => categories.all(providerId, kind) as Category[],
    listItems(categoryId, cursor, limit) {
      let rows: ItemRow[];
      // Fetch one extra row to learn whether another page exists.
      if (cursor === null) {
        rows = firstPage.all({ categoryId, limit: limit + 1 }) as ItemRow[];
      } else {
        const c = decodeCursor(cursor);
        if (!c) return undefined;
        rows = nextPage.all({ categoryId, ...c, limit: limit + 1 }) as ItemRow[];
      }
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(toItem),
        nextCursor: more && last ? encodeCursor(last.position!, last.id) : null,
      };
    },
    getItem(id) {
      const r = one.get(id) as (ItemRow & { remoteId: string; containerExt: string | null }) | undefined;
      return r ? { ...toItem(r), remoteId: r.remoteId, containerExt: r.containerExt } : undefined;
    },
  };
}
