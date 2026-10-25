import type { EpisodeDetail, SeasonDetail } from '@tv/shared';

/** Seasons in watching order: 1, 2, 3 …, then the specials (season 0), which are extras. */
export function bySeason(a: { season: number }, b: { season: number }): number {
  return Number(a.season === 0) - Number(b.season === 0) || a.season - b.season;
}

/** Every episode in watching order: season by season, then by episode number. */
function inOrder(seasons: SeasonDetail[]): EpisodeDetail[] {
  return [...seasons].sort(bySeason).flatMap((s) => [...s.episodes].sort((a, b) => a.episodeNum - b.episodeNum));
}

/** The episode after `remoteId`, into the next season when it ends one; null after the last, or for an unknown one. */
export function nextEpisode(seasons: SeasonDetail[], remoteId: string): EpisodeDetail | null {
  const all = inOrder(seasons);
  const at = all.findIndex((e) => e.remoteId === remoteId);
  return at < 0 ? null : (all[at + 1] ?? null);
}

/** The season `remoteId` is in. */
export function seasonOf(seasons: SeasonDetail[], remoteId: string): SeasonDetail | null {
  return seasons.find((s) => s.episodes.some((e) => e.remoteId === remoteId)) ?? null;
}
