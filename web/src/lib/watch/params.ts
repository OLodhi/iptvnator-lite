export type CatchupWindow = { startSec: number; stopSec: number; title: string };

export type WatchParams = {
  itemId: number;
  episode: string | null;
  /** Where to start, in seconds; 0 when absent or not a positive number. */
  t: number;
  catchup: CatchupWindow | null;
  /** The category the page was opened from: a category id, or `favourites`. */
  category: string | null;
};

const POSITIVE = /^[1-9]\d*$/;

const positiveInteger = (s: string | null): s is string => s !== null && POSITIVE.test(s) && Number.isSafeInteger(Number(s));

/** Catch-up mode: from and to are positive integers and to is after from. Anything else plays normally. */
function catchupOf(q: URLSearchParams): CatchupWindow | null {
  const from = q.get('from');
  const to = q.get('to');
  if (!positiveInteger(from) || !positiveInteger(to) || Number(to) <= Number(from)) return null;
  return { startSec: Number(from), stopSec: Number(to), title: (q.get('title') ?? '').trim() };
}

function categoryOf(q: URLSearchParams): string | null {
  const cat = q.get('cat');
  return cat === 'favourites' || positiveInteger(cat) ? cat : null;
}

/** What `/watch` was asked to play. */
export function parseWatchParams(url: URL): WatchParams {
  const q = url.searchParams;
  const t = Number(q.get('t'));
  return {
    itemId: Number(q.get('item')),
    episode: q.get('episode') || null,
    t: Number.isFinite(t) && t > 0 ? t : 0,
    catchup: catchupOf(q),
    category: categoryOf(q),
  };
}
