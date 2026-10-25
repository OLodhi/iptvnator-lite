import type { Config } from '../config.ts';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import type { VodInfoCache } from '../catalogue/vodInfo.ts';
import { createLogoCache, type LogoCache } from './cache.ts';

/** poster, backdrop, season-<n> or episode-<remoteId>. */
export const ART_SLOT = /^(poster|backdrop|season-\d{1,3}|episode-[\w-]{1,64})$/;

/** The server-relative path the browser is given in place of a provider image URL. */
export const artPath = (itemId: number, slot: string): string => `/api/art/${itemId}/${slot}`;

/** Artwork is proxied and cached like logos, with a larger size cap. */
export const createArtCache = (config: Config): LogoCache =>
  createLogoCache({
    dir: config.artDir,
    now: Date.now,
    userAgent: config.defaultUserAgent,
    allowPrivate: config.allowPrivateImageHosts,
    maxBytes: 5_000_000,
  });

/** The provider's image URL for an item's slot, or null when there is none. Never supplied by a client. */
export async function providerArtUrl(
  deps: { catalogue: CatalogueRepo; seriesInfo: SeriesInfoCache; vodInfo: VodInfoCache },
  itemId: number,
  slot: string,
): Promise<string | null> {
  const item = deps.catalogue.getItem(itemId);
  if (item?.kind === 'series') {
    const d = await deps.seriesInfo.getDetails(itemId);
    if (slot === 'poster') return d.meta.coverUrl;
    if (slot === 'backdrop') return d.meta.backdropUrls[0] ?? null;
    if (slot.startsWith('season-')) return d.seasonMeta[Number(slot.slice(7))]?.coverUrl ?? null;
    const remoteId = slot.slice(8);
    for (const s of d.seasons) {
      const e = s.episodes.find((x) => x.remoteId === remoteId);
      if (e) return e.imageUrl;
    }
    return null;
  }
  if (item?.kind === 'movie') {
    const v = await deps.vodInfo.getDetails(itemId);
    if (slot === 'poster') return v?.coverUrl ?? null;
    if (slot === 'backdrop') return v?.backdropUrls[0] ?? null;
  }
  return null;
}
