import type { CatalogItem, Programme, WatchContext } from '@tv/shared';
import { api } from '../api.ts';
import { programmes } from '../guide.ts';
import { formatClock } from '../guide/time.ts';
import { loadChannelOrder } from './channels.ts';

/** How far ahead the next programme is looked for. */
const NEXT_WINDOW_SEC = 6 * 3600;

/** What the list follows on the watch page. Read reactively: pass getters. */
export type ChannelListSource = {
  /** Live or catch-up: only a channel has a list. */
  readonly channel: boolean;
  /** Only live has a Next programme. */
  readonly live: boolean;
  readonly itemId: number;
  /** The category the page was opened from: a category id, or `favourites`. */
  readonly askedCategory: string | null;
  /** The item being watched, once fetched. */
  readonly item: CatalogItem | null;
};

export type ChannelList = {
  /** The channels below: the category the page was opened from, else the channel's first visible live category. */
  readonly category: string | null;
  /** The list's guide filter; null for anything but a channel, or while its category is unknown. */
  readonly filter: string | null;
  /** The category's name, or Favourites; empty until known. */
  readonly label: string;
  /** The category's guide: where ▦ Guide goes, and Back without history. */
  readonly guideHref: string;
  /** The list's channels in order, for channel up and down. */
  readonly order: number[];
  /** "Sports · channel 4 of 85", once the order is known. */
  readonly where: string | null;
  /** Live: "Next · 21:00 Title", once known. */
  readonly nextLabel: string | undefined;
};

/** A channel's list on the watch page: its category, the channels in order, and what follows the programme on now. */
export function createChannelList(source: ChannelListSource): ChannelList {
  /** The server's word on a channel's category: the one asked for when it is one of the channel's, else its first visible one. */
  let context = $state.raw<(WatchContext & { itemId: number; asked: string | null }) | null>(null);
  $effect(() => {
    if (!source.channel) return;
    const id = source.itemId;
    const asked = source.askedCategory;
    let cancelled = false;
    api<WatchContext>(`/api/items/${id}/context${asked ? `?category=${encodeURIComponent(asked)}` : ''}`).then(
      (ctx) => {
        if (!cancelled) context = { ...ctx, itemId: id, asked };
      },
      () => {}, // no list is better than a broken page
    );
    return () => {
      cancelled = true;
    };
  });

  const category = $derived(
    source.askedCategory ??
      (context?.itemId === source.itemId && context.categoryId !== null ? String(context.categoryId) : null),
  );
  const filter = $derived(!source.channel || category === null ? null : category === 'favourites' ? 'favourites' : `category:${category}`);
  const guideHref = $derived(category ? `/browse/live/${category}` : '/browse/live');
  // Switching channel within the category keeps its name while the new channel's answer is on its way.
  const label = $derived(
    context && (context.itemId === source.itemId || (source.askedCategory !== null && context.asked === source.askedCategory))
      ? (context.label ?? '')
      : '',
  );

  /** Loaded once per list, not per channel. */
  let loadedOrder = $state.raw<{ filter: string; ids: number[] } | null>(null);
  $effect(() => {
    const f = filter;
    if (!f) return;
    const ctl = new AbortController();
    loadChannelOrder(f, ctl.signal).then(
      (ids) => (loadedOrder = { filter: f, ids }),
      () => {}, // without it, no channel up and down
    );
    return () => ctl.abort();
  });
  const order = $derived(loadedOrder && loadedOrder.filter === filter ? loadedOrder.ids : []);
  const where = $derived.by(() => {
    const at = order.indexOf(source.itemId);
    return at < 0 ? null : [label, `channel ${at + 1} of ${order.length}`].filter(Boolean).join(' · ');
  });

  /** What follows the programme on now, fetched again whenever the item (and so its on-now line) is. */
  let next = $state.raw<{ itemId: number; programme: Programme | null } | null>(null);
  $effect(() => {
    const it = source.item;
    if (!source.live || !it || it.id !== source.itemId) return;
    const ctl = new AbortController();
    const from = Math.floor(Date.now() / 1000);
    const after = it.now?.stopSec ?? from;
    programmes([it.id], from, from + NEXT_WINDOW_SEC, ctl.signal).then(
      (found) => {
        const upcoming = (found[it.id] ?? []).filter((p) => p.startSec >= after).sort((a, b) => a.startSec - b.startSec);
        next = { itemId: it.id, programme: upcoming[0] ?? null };
      },
      () => {},
    );
    return () => ctl.abort();
  });
  const nextLabel = $derived.by(() => {
    const p = next?.itemId === source.itemId ? next.programme : null;
    return p ? `Next · ${formatClock(p.startSec)} ${p.title}` : undefined;
  });

  return {
    get category() {
      return category;
    },
    get filter() {
      return filter;
    },
    get label() {
      return label;
    },
    get guideHref() {
      return guideHref;
    },
    get order() {
      return order;
    },
    get where() {
      return where;
    },
    get nextLabel() {
      return nextLabel;
    },
  };
}
