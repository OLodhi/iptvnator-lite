import type { BrowseCategory, BrowseView, CatalogItem, ContinueItem, Kind } from '@tv/shared';
import type { CatalogueRepo, ItemDetail, StoredItem } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import type { CurationService } from '../curation/service.ts';
import type { PersonalService } from '../personal/service.ts';

export const RECENT_LIMIT = 20;
export const FAVOURITES_LIMIT = 50;
export const CONTINUE_LIMIT = 20;

export interface Presenter {
  /** Adds `displayName` and `favourite` for the user; anything the repo stores beyond a stored item's public fields is dropped. */
  items(stored: StoredItem[], userId: number): CatalogItem[];
  browse(userId: number, providerId: number, kind: Kind): Promise<BrowseView>;
}

export function createPresenter(deps: {
  curation: CurationService;
  personal: PersonalService;
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
}): Presenter {
  const { curation, personal, catalogue } = deps;

  /** One kind's resolution and favourites, worked out once and applied to many items. */
  function presenterFor(userId: number, providerId: number, kind: Kind) {
    const { displayName } = curation.resolution(providerId, kind, userId);
    const favourites = new Set(personal.favouriteItemIds(userId, providerId, kind));
    return (i: StoredItem): CatalogItem => ({
      id: i.id,
      providerId: i.providerId,
      kind: i.kind,
      name: i.name,
      logoUrl: i.logoUrl,
      catchupDays: i.catchupDays,
      year: i.year,
      rating: i.rating,
      displayName: displayName(i.name),
      favourite: favourites.has(i.id),
    });
  }

  function items(stored: StoredItem[], userId: number): CatalogItem[] {
    const present = new Map<string, (i: StoredItem) => CatalogItem>();
    return stored.map((i) => {
      const key = `${i.providerId}:${i.kind}`;
      let fn = present.get(key);
      if (!fn) present.set(key, (fn = presenterFor(userId, i.providerId, i.kind)));
      return fn(i);
    });
  }

  const resolveItems = (ids: number[]): ItemDetail[] =>
    ids.map((id) => catalogue.getItem(id)).filter((i): i is ItemDetail => i !== undefined);

  /** "S<season> E<num>"; null when the series info is unavailable or no longer lists the episode. */
  async function episodeLabel(itemId: number, episodeRemoteId: string): Promise<string | null> {
    try {
      for (const s of await deps.seriesInfo.getSeasons(itemId)) {
        const e = s.episodes.find((x) => x.remoteId === episodeRemoteId);
        if (e) return `S${s.season} E${e.episodeNum}`;
      }
    } catch {
      // A provider hiccup must not fail the browse view.
    }
    return null;
  }

  return {
    items,
    async browse(userId, providerId, kind) {
      const { visibleIds, displayName, newCount } = curation.resolution(providerId, kind, userId);
      const pinnedIds = new Set(personal.pinnedCategoryIds(userId, providerId, kind));
      const categories: BrowseCategory[] = catalogue
        .listCategories(providerId, kind)
        .filter((c) => visibleIds.has(c.id))
        .map((c) => ({ id: c.id, displayName: displayName(c.name), itemCount: c.itemCount, pinned: pinnedIds.has(c.id) }));
      const byId = new Map(categories.map((c) => [c.id, c]));
      const present = presenterFor(userId, providerId, kind);

      const continuing = kind === 'live' ? [] : personal.continueWatching(userId, providerId, kind, CONTINUE_LIMIT);
      const continueWatching = (
        await Promise.all(
          continuing.map(async (entry): Promise<ContinueItem | undefined> => {
            const stored = catalogue.getItem(entry.itemId);
            if (!stored) return undefined;
            return {
              item: present(stored),
              episodeRemoteId: entry.episodeRemoteId,
              episodeLabel: entry.episodeRemoteId === null ? null : await episodeLabel(stored.id, entry.episodeRemoteId),
              positionSec: entry.positionSec,
              durationSec: entry.durationSec,
            };
          }),
        )
      ).filter((c): c is ContinueItem => c !== undefined);
      return {
        providerId,
        kind,
        categories,
        pinned: personal
          .pinnedCategoryIds(userId, providerId, kind)
          .map((id) => byId.get(id))
          .filter((c): c is BrowseCategory => c !== undefined),
        recent: resolveItems(personal.recentItemIds(userId, providerId, kind, RECENT_LIMIT)).map(present),
        favourites: resolveItems(personal.favouriteItemIds(userId, providerId, kind).slice(0, FAVOURITES_LIMIT)).map(present),
        continueWatching,
        newCategories: newCount,
      };
    },
  };
}
