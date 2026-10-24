import type { Season } from '@tv/shared';
import type { ProviderService } from '../providers/service.ts';
import type { SeriesInfo } from '../providers/xtream/client.ts';
import type { CatalogueRepo } from './repo.ts';

export type EpisodeSource = {
  remoteId: string;
  containerExt: string;
  durationSec: number | null;
  season: number;
  episodeNum: number;
};

export interface SeriesInfoCache {
  getSeasons(itemId: number): Promise<Season[]>;
  getEpisode(itemId: number, episodeRemoteId: string): Promise<EpisodeSource | undefined>;
}

export function createSeriesInfoCache(deps: {
  providers: ProviderService;
  catalogue: CatalogueRepo;
  ttlMs?: number;
}): SeriesInfoCache {
  const ttlMs = deps.ttlMs ?? 600_000;
  const entries = new Map<number, { at: number; info: Promise<SeriesInfo> }>();

  async function load(itemId: number): Promise<SeriesInfo | undefined> {
    const item = deps.catalogue.getItem(itemId);
    if (!item || item.kind !== 'series') return undefined;
    const hit = entries.get(itemId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.info;
    const info = deps.providers.clientFor(item.providerId).getSeriesInfo(item.remoteId);
    entries.set(itemId, { at: Date.now(), info });
    // Failures are not cached.
    info.catch(() => {
      if (entries.get(itemId)?.info === info) entries.delete(itemId);
    });
    return info;
  }

  return {
    async getSeasons(itemId) {
      const info = await load(itemId);
      return (info?.seasons ?? [])
        .map((s) => ({
          season: s.season,
          episodes: s.episodes
            .map((e) => ({ remoteId: e.remoteId, title: e.title, episodeNum: e.episodeNum, durationSec: e.durationSec }))
            .sort((a, b) => a.episodeNum - b.episodeNum),
        }))
        .sort((a, b) => a.season - b.season);
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
