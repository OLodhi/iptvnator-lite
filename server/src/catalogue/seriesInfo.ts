import type { Quality, Season } from '@tv/shared';
import type { ProviderService } from '../providers/service.ts';
import type { ProviderEpisode, SeriesInfo, SeriesMeta } from '../providers/xtream/client.ts';
import { cleanEpisodeTitle, qualityLabel } from './episodeTitle.ts';
import type { CatalogueRepo } from './repo.ts';
import { createTtlCache } from './ttlCache.ts';

/** How long a series' provider details stay cached, and how many series are kept (the oldest goes first). */
export const SERIES_TTL_MS = 3_600_000;
export const SERIES_CACHE_MAX = 200;

export type EpisodeSource = {
  remoteId: string;
  containerExt: string;
  durationSec: number | null;
  season: number;
  episodeNum: number;
};

export type SeriesDetailEpisode = {
  remoteId: string;
  /** Cleaned. */
  title: string;
  episodeNum: number;
  durationSec: number | null;
  /** The provider's still. Server-internal: the browser is given an /api/art path instead. */
  imageUrl: string | null;
  airDate: string | null;
  quality: Quality | null;
};

/** Server-internal: the artwork URLs in here are the provider's, and are swapped for /api/art paths before the browser sees them. */
export type SeriesDetailsData = {
  meta: SeriesMeta;
  seasonMeta: SeriesInfo['seasonMeta'];
  seasons: { season: number; name: string; episodes: SeriesDetailEpisode[] }[];
};

export interface SeriesInfoCache {
  getSeasons(itemId: number): Promise<Season[]>;
  getDetails(itemId: number): Promise<SeriesDetailsData>;
  getEpisode(itemId: number, episodeRemoteId: string): Promise<EpisodeSource | undefined>;
}

// Duplicate episode numbers are kept; ties break on the provider's id, numerically when both are numbers.
function byNumberThenId(a: ProviderEpisode, b: ProviderEpisode): number {
  if (a.episodeNum !== b.episodeNum) return a.episodeNum - b.episodeNum;
  const x = Number(a.remoteId);
  const y = Number(b.remoteId);
  return Number.isNaN(x) || Number.isNaN(y) ? a.remoteId.localeCompare(b.remoteId) : x - y;
}

const seasonName = (n: number, meta: SeriesInfo['seasonMeta']) => (n === 0 ? 'Specials' : (meta[n]?.name ?? `Season ${n}`));

export function createSeriesInfoCache(deps: {
  providers: ProviderService;
  catalogue: CatalogueRepo;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): SeriesInfoCache {
  const cache = createTtlCache<SeriesInfo>({
    ttlMs: deps.ttlMs ?? SERIES_TTL_MS,
    maxEntries: deps.maxEntries ?? SERIES_CACHE_MAX,
    now: deps.now ?? Date.now,
  });

  async function load(itemId: number): Promise<SeriesInfo | undefined> {
    const item = deps.catalogue.getItem(itemId);
    if (!item || item.kind !== 'series') return undefined;
    return cache.get(itemId, () => deps.providers.clientFor(item.providerId).getSeriesInfo(item.remoteId));
  }

  // Seasons come from the episodes, not the provider's seasons list, which can be missing or incomplete.
  function ordered(info: SeriesInfo | undefined) {
    return (info?.seasons ?? [])
      .map((s) => ({ season: s.season, episodes: [...s.episodes].sort(byNumberThenId) }))
      .sort((a, b) => a.season - b.season);
  }

  return {
    async getSeasons(itemId) {
      return ordered(await load(itemId)).map((s) => ({
        season: s.season,
        episodes: s.episodes.map((e) => ({
          remoteId: e.remoteId,
          title: cleanEpisodeTitle(e.title, e.episodeNum),
          episodeNum: e.episodeNum,
          durationSec: e.durationSec,
        })),
      }));
    },
    async getDetails(itemId) {
      const info = await load(itemId);
      return {
        meta: info?.meta ?? { name: null, plot: null, genre: null, cast: null, director: null, releaseDate: null, rating: null, coverUrl: null, backdropUrls: [] },
        seasonMeta: info?.seasonMeta ?? {},
        seasons: ordered(info).map((s) => ({
          season: s.season,
          name: seasonName(s.season, info?.seasonMeta ?? {}),
          episodes: s.episodes.map((e) => ({
            remoteId: e.remoteId,
            title: cleanEpisodeTitle(e.title, e.episodeNum),
            episodeNum: e.episodeNum,
            durationSec: e.durationSec,
            imageUrl: e.imageUrl,
            airDate: e.airDate,
            quality: qualityLabel(e.width, e.height),
          })),
        })),
      };
    },
    async getEpisode(itemId, episodeRemoteId) {
      const info = await load(itemId);
      for (const s of info?.seasons ?? []) {
        const e = s.episodes.find((x) => x.remoteId === episodeRemoteId);
        if (e) return { remoteId: e.remoteId, containerExt: e.containerExt, durationSec: e.durationSec, season: s.season, episodeNum: e.episodeNum };
      }
      return undefined;
    },
  };
}
