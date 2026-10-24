import type { BrowseCategory, BrowseView, CatalogItem, ContinueItem, Kind } from '@tv/shared';
import type { CatalogueRepo, ItemDetail, StoredItem } from '../catalogue/repo.ts';
import type { CurationService, Resolution } from '../curation/service.ts';
import type { PersonalService } from '../personal/service.ts';

export const RECENT_LIMIT = 20;
export const FAVOURITES_LIMIT = 50;
export const CONTINUE_LIMIT = 20;

export interface Presenter {
  /** Resolves each kind once and adds `displayName` and `favourite` for the user; internal fields are dropped. */
  items(stored: StoredItem[], userId: number): CatalogItem[];
  /** The same for a caller that has already resolved the kind (and loaded the user's favourites for it). */
  itemsWith(resolution: Pick<Resolution, 'displayName'>, favourites: Set<number>, stored: StoredItem[]): CatalogItem[];
  browse(userId: number, providerId: number, kind: Kind): Promise<BrowseView>;
}

export function createPresenter(deps: {
  curation: CurationService;
  personal: PersonalService;
  catalogue: CatalogueRepo;
}): Presenter {
  const { curation, personal, catalogue } = deps;

  const present =
    (displayName: (name: string) => string, favourites: Set<number>) =>
    (i: StoredItem): CatalogItem => ({
      id: i.id,
      providerId: i.providerId,
      kind: i.kind,
      name: i.name,
      // Never the provider's own URL: the server fetches and caches the image.
      logoUrl: i.logoUrl ? `/api/logos/${i.id}` : null,
      catchupDays: i.catchupDays,
      year: i.year,
      rating: i.rating,
      displayName: displayName(i.name),
      favourite: favourites.has(i.id),
    });

  const itemsWith: Presenter['itemsWith'] = (resolution, favourites, stored) =>
    stored.map(present(resolution.displayName, favourites));

  function items(stored: StoredItem[], userId: number): CatalogItem[] {
    const fns = new Map<string, (i: StoredItem) => CatalogItem>();
    return stored.map((i) => {
      const key = `${i.providerId}:${i.kind}`;
      let fn = fns.get(key);
      if (!fn) {
        const { displayName } = curation.resolution(i.providerId, i.kind, userId);
        fns.set(key, (fn = present(displayName, new Set(personal.favouriteItemIds(userId, i.providerId, i.kind)))));
      }
      return fn(i);
    });
  }

  const resolveItems = (ids: number[]): ItemDetail[] =>
    ids.map((id) => catalogue.getItem(id)).filter((i): i is ItemDetail => i !== undefined);

  return {
    items,
    itemsWith,
    async browse(userId, providerId, kind) {
      const resolution = curation.resolution(providerId, kind, userId);
      const { visibleIds, displayName, newCount } = resolution;
      const pinnedIds = personal.pinnedCategoryIds(userId, providerId, kind);
      const pinnedSet = new Set(pinnedIds);
      const categories: BrowseCategory[] = catalogue
        .listCategories(providerId, kind)
        .filter((c) => visibleIds.has(c.id))
        .map((c) => ({ id: c.id, displayName: displayName(c.name), itemCount: c.itemCount, pinned: pinnedSet.has(c.id) }));
      const byId = new Map(categories.map((c) => [c.id, c]));
      const favouriteIds = personal.favouriteItemIds(userId, providerId, kind);
      const show = present(displayName, new Set(favouriteIds));

      const continuing = kind === 'live' ? [] : personal.continueWatching(userId, providerId, kind, CONTINUE_LIMIT);
      const continueWatching: ContinueItem[] = [];
      for (const entry of continuing) {
        const stored = catalogue.getItem(entry.itemId);
        if (!stored) continue;
        continueWatching.push({
          item: show(stored),
          episodeRemoteId: entry.episodeRemoteId,
          episodeLabel: entry.episodeLabel,
          positionSec: entry.positionSec,
          durationSec: entry.durationSec,
        });
      }
      return {
        providerId,
        kind,
        categories,
        pinned: pinnedIds.map((id) => byId.get(id)).filter((c): c is BrowseCategory => c !== undefined),
        recent: resolveItems(personal.recentItemIds(userId, providerId, kind, RECENT_LIMIT)).map((i) => show(i)),
        favourites: resolveItems(favouriteIds.slice(0, FAVOURITES_LIMIT)).map((i) => show(i)),
        continueWatching,
        newCategories: newCount,
      };
    },
  };
}
