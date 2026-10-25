import type { ProviderService } from '../providers/service.ts';
import type { VodInfo } from '../providers/xtream/client.ts';
import type { CatalogueRepo } from './repo.ts';
import { SERIES_CACHE_MAX, SERIES_TTL_MS } from './seriesInfo.ts';
import { createTtlCache } from './ttlCache.ts';

export interface VodInfoCache {
  /** A movie's details from the provider; null when itemId is not a movie. Fields the provider does not know are null. */
  getDetails(itemId: number): Promise<VodInfo | null>;
}

export function createVodInfoCache(deps: {
  providers: ProviderService;
  catalogue: CatalogueRepo;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): VodInfoCache {
  const cache = createTtlCache<VodInfo>({
    ttlMs: deps.ttlMs ?? SERIES_TTL_MS,
    maxEntries: deps.maxEntries ?? SERIES_CACHE_MAX,
    now: deps.now ?? Date.now,
  });
  return {
    async getDetails(itemId) {
      const item = deps.catalogue.getItem(itemId);
      if (!item || item.kind !== 'movie') return null;
      return cache.get(itemId, () => deps.providers.clientFor(item.providerId).getVodInfo(item.remoteId));
    },
  };
}
