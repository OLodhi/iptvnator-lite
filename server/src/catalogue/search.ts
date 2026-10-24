import type { Kind } from '@tv/shared';
import type { Db } from '../db/db.ts';
import { ITEM_COLUMNS } from './repo.ts';
import type { StoredItem } from './repo.ts';

/** Below this many characters the trigram index has nothing to match, so the query is a name prefix instead. */
const MIN_FTS_CHARS = 3;

export interface Search {
  /**
   * Items of the kind matching `query`, only those with a visible category; at most `limit`. `visible` is the visible
   * category ids, or 'all' when every category of the kind is visible, which spares the check.
   */
  items(providerId: number, kind: Kind, query: string, visible: Set<number> | 'all', limit: number): StoredItem[];
}

/** Wrapped as one phrase with its quotes doubled, so FTS operators in the query are plain text. */
const asPhrase = (q: string): string => `"${q.replaceAll('"', '""')}"`;
const escapeLike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

// At the top level, so SQLite works out the visible items once per query rather than once per matching row
// (better-sqlite3 is synchronous: every stream request waits for a search). The ids travel as one JSON array so a
// large curation never meets SQLite's bound-variable limit.
const VISIBLE = `items.id IN (SELECT ic.item_id FROM item_categories ic
                               WHERE ic.category_id IN (SELECT value FROM json_each(@visible)))`;
// Every category visible: an item needs only a category, as it does to be listed anywhere.
const LINKED = 'EXISTS (SELECT 1 FROM item_categories ic WHERE ic.item_id = items.id)';

export function createSearch(db: Db): Search {
  const fts = (filter: string) =>
    db.prepare(
      `SELECT ${ITEM_COLUMNS} FROM items_fts JOIN items ON items.id = items_fts.rowid
        WHERE items_fts MATCH @match AND items.provider_id = @providerId AND items.kind = @kind AND ${filter}
        ORDER BY items_fts.rank, items.id LIMIT @limit`,
    );
  const prefix = (filter: string) =>
    db.prepare(
      `SELECT ${ITEM_COLUMNS} FROM items
        WHERE items.name LIKE @pattern ESCAPE '\\' AND items.provider_id = @providerId AND items.kind = @kind AND ${filter}
        ORDER BY items.name, items.id LIMIT @limit`,
    );
  const statements = {
    some: { fts: fts(VISIBLE), prefix: prefix(VISIBLE) },
    all: { fts: fts(LINKED), prefix: prefix(LINKED) },
  };

  return {
    items(providerId, kind, query, visible, limit) {
      // FTS5 reads the match string as a C string, so control characters (NUL above all) are dropped first.
      const q = query.replace(/\p{Cc}/gu, '').trim();
      if (q === '' || (visible !== 'all' && visible.size === 0)) return [];
      const { fts, prefix } = visible === 'all' ? statements.all : statements.some;
      const common = visible === 'all' ? { providerId, kind, limit } : { providerId, kind, limit, visible: JSON.stringify([...visible]) };
      try {
        const rows =
          [...q].length < MIN_FTS_CHARS
            ? prefix.all({ ...common, pattern: `${escapeLike(q)}%` })
            : fts.all({ ...common, match: asPhrase(q) });
        return rows as StoredItem[];
      } catch (err) {
        // A query FTS cannot parse is a query with no matches, never a server error.
        if (err instanceof Error && err.name === 'SqliteError') return [];
        throw err;
      }
    },
  };
}
