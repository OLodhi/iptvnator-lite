import type { Kind } from '@tv/shared';
import type { Db } from '../db/db.ts';
import { ITEM_COLUMNS } from './repo.ts';
import type { StoredItem } from './repo.ts';

/** Below this many characters the trigram index has nothing to match, so the query is a name prefix instead. */
const MIN_FTS_CHARS = 3;

export interface Search {
  /** Items of the kind matching `query`, only those with a category in `visibleCategoryIds`; at most `limit`. */
  items(providerId: number, kind: Kind, query: string, visibleCategoryIds: Set<number>, limit: number): StoredItem[];
}

/** Wrapped as one phrase with its quotes doubled, so FTS operators in the query are plain text. */
const asPhrase = (q: string): string => `"${q.replaceAll('"', '""')}"`;
const escapeLike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

// Visible ids travel as one JSON array so a large curation never meets SQLite's bound-variable limit.
const VISIBLE = `EXISTS (SELECT 1 FROM item_categories ic
                          WHERE ic.item_id = items.id AND ic.category_id IN (SELECT value FROM json_each(@visible)))`;

export function createSearch(db: Db): Search {
  const fts = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM items_fts JOIN items ON items.id = items_fts.rowid
      WHERE items_fts MATCH @match AND items.provider_id = @providerId AND items.kind = @kind AND ${VISIBLE}
      ORDER BY items_fts.rank, items.id LIMIT @limit`,
  );
  const prefix = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM items
      WHERE items.name LIKE @pattern ESCAPE '\\' AND items.provider_id = @providerId AND items.kind = @kind AND ${VISIBLE}
      ORDER BY items.name, items.id LIMIT @limit`,
  );

  return {
    items(providerId, kind, query, visibleCategoryIds, limit) {
      const q = query.trim();
      if (q === '' || visibleCategoryIds.size === 0) return [];
      const common = { providerId, kind, limit, visible: JSON.stringify([...visibleCategoryIds]) };
      const rows =
        [...q].length < MIN_FTS_CHARS
          ? prefix.all({ ...common, pattern: `${escapeLike(q)}%` })
          : fts.all({ ...common, match: asPhrase(q) });
      return rows as StoredItem[];
    },
  };
}
