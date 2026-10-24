import type { BrowseView, Kind } from '@tv/shared';

export type SectionKey = 'continue' | 'recent' | 'favourites' | 'pinned' | 'all';
export type Section = { key: SectionKey; title: string; kind: 'items' | 'categories' | 'continue' };

/** The sections of a tab screen, in display order, without the empty ones. */
export function browseSections(view: BrowseView): Section[] {
  const live = view.kind === 'live';
  const candidates: (Section & { count: number })[] = [
    live
      ? { key: 'recent', title: 'Recently watched', kind: 'items', count: view.recent.length }
      : { key: 'continue', title: 'Continue watching', kind: 'continue', count: view.continueWatching.length },
    { key: 'favourites', title: live ? 'Favourite channels' : 'Favourites', kind: 'items', count: view.favourites.length },
    { key: 'pinned', title: 'Pinned', kind: 'categories', count: view.pinned.length },
    { key: 'all', title: 'All categories', kind: 'categories', count: view.categories.length },
  ];
  return candidates.filter((c) => c.count > 0).map(({ count: _count, ...section }) => section);
}

export const POSTER_GUTTER = 12;
const POSTER_CAPTION = 46;

/** Height of one poster-grid row: a 2:3 poster in a third of `gridWidth`, plus caption and gap. */
export function posterRowHeight(gridWidth: number, columns = 3): number {
  const poster = gridWidth / columns - POSTER_GUTTER;
  return Math.ceil(Math.max(poster, 0) * 1.5) + POSTER_CAPTION + POSTER_GUTTER;
}

/** Up to two letters for the placeholder tile: initials of the first two words. */
export function initials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

/** A stable hue (0-359) for a name, so each placeholder tile keeps its colour. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

export function newCategoriesBanner(view: BrowseView): { text: string; href: string } | null {
  if (view.newCategories <= 0) return null;
  return {
    text: `${view.newCategories} new categories — review`,
    href: `/settings/categories?kind=${view.kind satisfies Kind}`,
  };
}
