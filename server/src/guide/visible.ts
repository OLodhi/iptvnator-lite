import type { Db } from '../db/db.ts';
import type { CurationService } from '../curation/service.ts';

/**
 * The live items the user can see: those in visible live categories, by category position and then item position.
 * An item in several visible categories is listed once, at its first place.
 */
export function visibleLiveItemIds(db: Db, curation: CurationService, providerId: number, userId: number): number[] {
  const categoryIds = [...curation.resolution(providerId, 'live', userId).visibleIds];
  if (categoryIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT ic.item_id AS id
         FROM item_categories ic
         JOIN categories c ON c.id = ic.category_id
        WHERE ic.category_id IN (SELECT value FROM json_each(?)) AND c.provider_id = ? AND c.kind = 'live'
        ORDER BY c.position, ic.position, ic.item_id`,
    )
    .pluck()
    .all(JSON.stringify(categoryIds), providerId) as number[];
  return [...new Set(rows)];
}
