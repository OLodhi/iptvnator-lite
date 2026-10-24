import type { PlayRequest } from '@tv/shared';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import type { ProviderService } from '../providers/service.ts';

export type ResolvedSource = {
  providerId: number;
  kind: 'live' | 'movie' | 'episode';
  contentKey: string;
  /** Carries provider credentials: never log it unredacted or send it to the browser. */
  sourceUrl: string;
  /** Live m3u8 only: the continuous TS stream, if the playlist turns out to be finite (R29). Carries credentials too. */
  fallbackSourceUrl?: string;
};

/** Why a play request names nothing playable. */
export class SourceError extends Error {
  code: 'NOT_FOUND' | 'VALIDATION';

  constructor(code: 'NOT_FOUND' | 'VALIDATION', message: string) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

/** Turns a catalogue item (and, for a series, one of its episodes) into the provider stream URL to play. */
export async function resolveSourceUrl(
  deps: { catalogue: CatalogueRepo; seriesInfo: SeriesInfoCache; providers: ProviderService },
  req: PlayRequest,
): Promise<ResolvedSource> {
  const item = deps.catalogue.getItem(req.itemId);
  if (!item) throw new SourceError('NOT_FOUND', `Item ${req.itemId} not found`);
  const { providerId } = item;
  const client = deps.providers.clientFor(providerId);

  if (item.kind === 'live') {
    const formats = deps.providers.account(providerId)?.allowedOutputFormats ?? [];
    const format = formats.includes('m3u8') ? 'm3u8' : 'ts';
    const source: ResolvedSource = {
      providerId,
      kind: 'live',
      contentKey: `live:${item.remoteId}`,
      sourceUrl: client.liveUrl(item.remoteId, format),
    };
    if (format === 'm3u8' && formats.includes('ts')) source.fallbackSourceUrl = client.liveUrl(item.remoteId, 'ts');
    return source;
  }
  if (item.kind === 'movie') {
    const sourceUrl = client.movieUrl(item.remoteId, item.containerExt ?? 'mp4');
    return { providerId, kind: 'movie', contentKey: `movie:${item.remoteId}`, sourceUrl };
  }

  if (req.episodeRemoteId === undefined) {
    throw new SourceError('VALIDATION', `Series ${req.itemId} needs an episodeRemoteId`);
  }
  const episode = await deps.seriesInfo.getEpisode(item.id, req.episodeRemoteId);
  if (!episode) throw new SourceError('NOT_FOUND', `Episode ${req.episodeRemoteId} of series ${req.itemId} not found`);
  const sourceUrl = client.episodeUrl(episode.remoteId, episode.containerExt);
  return { providerId, kind: 'episode', contentKey: `episode:${episode.remoteId}`, sourceUrl };
}
