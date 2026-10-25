import type { SavedPosition, Season } from '@tv/shared';
import { bySeason } from './watch/episodes.ts';

const MIN_RESUME_SEC = 5;

/** The saved position worth offering "Resume" for: this title/episode, unfinished, at least 5 s in. */
export function pickResume(positions: SavedPosition[], episodeRemoteId: string | null): SavedPosition | null {
  return positions.find((p) => p.episodeRemoteId === episodeRemoteId && !p.finished && p.positionSec >= MIN_RESUME_SEC) ?? null;
}

export type ResumeTarget = { episodeRemoteId: string; label: string; mode: 'continue' | 'play' | 'next' };

/**
 * The series page's primary button, in watching order (specials last). Where you are is the latest episode actually
 * played: Continue it while unfinished, else Play next, the first unwatched episode after it. A mark made by hand is
 * never where you are, but what comes next skips every watched episode. With nothing played, Play the first unwatched
 * episode; with everything watched, the first.
 */
export function pickTarget(seasons: Season[], positions: SavedPosition[]): ResumeTarget | null {
  const ordered = [...seasons]
    .sort(bySeason)
    .flatMap((s) =>
      [...s.episodes]
        .sort((a, b) => a.episodeNum - b.episodeNum)
        .map((ep) => ({ remoteId: ep.remoteId, label: `S${s.season} E${ep.episodeNum}` })),
    );
  if (ordered.length === 0) return null;
  const known = new Set(ordered.map((e) => e.remoteId));
  const mine = positions.filter((p) => p.episodeRemoteId !== null && known.has(p.episodeRemoteId));
  // Watched means finished, played or marked.
  const watched = new Set(mine.filter((p) => p.finished).map((p) => p.episodeRemoteId));
  const played = mine.filter((p) => !p.manual).sort((a, b) => b.updatedAt - a.updatedAt);
  const make = (e: (typeof ordered)[number], mode: ResumeTarget['mode']): ResumeTarget => ({ episodeRemoteId: e.remoteId, label: e.label, mode });
  const firstUnwatched = (from: number) => ordered.slice(from).find((e) => !watched.has(e.remoteId));

  const anchor = played[0];
  if (anchor) {
    const at = ordered.findIndex((e) => e.remoteId === anchor.episodeRemoteId);
    if (!anchor.finished) return make(ordered[at]!, 'continue');
    const next = firstUnwatched(at + 1);
    if (next) return make(next, 'next');
  }
  // After the last unwatched episode: an older one left unfinished, else from the top.
  const unfinished = played.find((p) => !p.finished);
  if (unfinished) return make(ordered.find((e) => e.remoteId === unfinished.episodeRemoteId)!, 'continue');
  return make(firstUnwatched(0) ?? ordered[0]!, 'play');
}
