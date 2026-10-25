export type WatchLinkOptions = {
  /** The live category the link is followed from: a category id, or `favourites`. */
  category?: string | null;
  episode?: string;
  catchup?: { startSec: number; stopSec: number; title: string };
};

/** A link to the watch page, in the query `parseWatchParams` reads. */
export function watchHref(itemId: number, opts: WatchLinkOptions = {}): string {
  let href = `/watch?item=${itemId}`;
  if (opts.episode) href += `&episode=${encodeURIComponent(opts.episode)}`;
  const c = opts.catchup;
  if (c) href += `&from=${c.startSec}&to=${c.stopSec}&title=${encodeURIComponent(c.title)}`;
  if (opts.category) href += `&cat=${encodeURIComponent(opts.category)}`;
  return href;
}

/** The category a guide filter shows, for its watch links: `category:<id>` gives `<id>`, `favourites` stays; All has none. */
export function filterCategory(filter: string): string | null {
  if (filter === 'favourites') return filter;
  return filter.startsWith('category:') ? filter.slice('category:'.length) : null;
}
