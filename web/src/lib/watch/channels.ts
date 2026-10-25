import type { GridRow, Page } from '@tv/shared';
import { grid } from '../guide.ts';

/** The route's largest page. */
const PAGE = 100;
/** Each page asks about the coming minute, like the list it orders. */
const WINDOW_SEC = 60;

/** Every channel in a guide filter, in the guide's order: what channel up and down move through. */
export async function loadChannelOrder(filter: string, signal?: AbortSignal): Promise<number[]> {
  const from = Math.floor(Date.now() / 1000);
  const ids: number[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<GridRow> = await grid({ filter, from, to: from + WINDOW_SEC, cursor, limit: PAGE }, signal);
    for (const row of page.items) ids.push(row.item.id);
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

/** The channel before (-1) or after (1) `current`; null at either end, or when `current` is not in the list. */
export function neighbour(ids: number[], current: number, dir: -1 | 1): number | null {
  const i = ids.indexOf(current);
  if (i < 0) return null;
  return ids[i + dir] ?? null;
}
