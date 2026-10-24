import type { PlayRequest } from '@tv/shared';
import type { CatalogueRepo, ItemDetail } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import type { ProviderService } from '../providers/service.ts';
import type { XtreamClient } from '../providers/xtream/client.ts';

/** The longest programme a catch-up request may ask for. */
export const MAX_CATCHUP_SEC = 8 * 3600;
// A programme that started a moment before the archive's edge is still offered.
const ARCHIVE_GRACE_SEC = 60;

export type ResolvedSource = {
  providerId: number;
  kind: 'live' | 'movie' | 'episode' | 'catchup';
  contentKey: string;
  /** Carries provider credentials: never log it unredacted or send it to the browser. */
  sourceUrl: string;
  /** Live m3u8 only: the continuous TS stream, if the playlist turns out to be finite (R29). Carries credentials too. */
  fallbackSourceUrl?: string;
  /** Catch-up only: the programme's length, which the timeshift stream itself does not reliably report. */
  durationHintSec?: number;
};

type SourceDeps = {
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
  providers: ProviderService;
  /** Epoch milliseconds; Date.now if left out. */
  now?: () => number;
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

/**
 * Turns a catalogue item (and, for a series, one of its episodes, or for a live channel, one of its past programmes)
 * into the provider stream URL to play.
 */
export async function resolveSourceUrl(deps: SourceDeps, req: PlayRequest): Promise<ResolvedSource> {
  const item = deps.catalogue.getItem(req.itemId);
  if (!item) throw new SourceError('NOT_FOUND', `Item ${req.itemId} not found`);
  const { providerId } = item;
  const client = deps.providers.clientFor(providerId);

  if (req.catchup) return catchupSource(deps, item, client, req.catchup);
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

/** An Xtream timeshift URL for a programme inside the channel's archive, formatted in the provider's timezone. */
function catchupSource(
  deps: SourceDeps,
  item: ItemDetail,
  client: XtreamClient,
  { startSec, stopSec }: { startSec: number; stopSec: number },
): ResolvedSource {
  const days = item.kind === 'live' ? (item.catchupDays ?? 0) : 0;
  if (days <= 0) throw new SourceError('VALIDATION', "This channel doesn't support catch-up");
  const nowSec = (deps.now ?? Date.now)() / 1000;
  if (startSec < nowSec - days * 86_400 - ARCHIVE_GRACE_SEC) {
    throw new SourceError('VALIDATION', `This channel keeps only ${days} day(s) of catch-up`);
  }
  if (startSec >= nowSec) throw new SourceError('VALIDATION', "That programme hasn't started yet");
  if (stopSec <= startSec) throw new SourceError('VALIDATION', 'A catch-up programme must stop after it starts');
  if (stopSec - startSec > MAX_CATCHUP_SEC) {
    throw new SourceError('VALIDATION', `Catch-up programmes are limited to ${MAX_CATCHUP_SEC / 3600} hours`);
  }

  const account = deps.providers.account(item.providerId);
  const formats = account?.allowedOutputFormats ?? [];
  const ext = formats.includes('m3u8') && !formats.includes('ts') ? 'm3u8' : 'ts';
  return {
    providerId: item.providerId,
    kind: 'catchup',
    contentKey: `catchup:${item.remoteId}:${startSec}`,
    sourceUrl: client.timeshiftUrl(item.remoteId, startSec, stopSec, account?.timezone ?? null, ext),
    durationHintSec: stopSec - startSec,
  };
}
