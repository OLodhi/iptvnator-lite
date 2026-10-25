import type { SavedPosition, Season } from '@tv/shared';
import { bySeason } from './watch/episodes.ts';

const MIN_RESUME_SEC = 5;

/** The saved position worth offering "Resume" for: this title/episode, unfinished, at least 5 s in. */
export function pickResume(positions: SavedPosition[], episodeRemoteId: string | null): SavedPosition | null {
  return positions.find((p) => p.episodeRemoteId === episodeRemoteId && !p.finished && p.positionSec >= MIN_RESUME_SEC) ?? null;
}

export type ResumeTarget = { episodeRemoteId: string; label: string; mode: 'continue' | 'play' | 'next' };

/**
 * The series page's primary button, following what was actually played: the episode after a finished latest one,
 * else the latest unfinished, else the first, in watching order (specials last). Episodes marked watched by hand stay
 * watched, but never count as where you are.
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
  const played = positions
    .filter((p) => !p.manual && p.episodeRemoteId !== null && known.has(p.episodeRemoteId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const make = (remoteId: string, mode: ResumeTarget['mode']): ResumeTarget => ({
    episodeRemoteId: remoteId,
    label: ordered.find((e) => e.remoteId === remoteId)!.label,
    mode,
  });

  const latest = played[0];
  if (latest?.finished) {
    const i = ordered.findIndex((e) => e.remoteId === latest.episodeRemoteId);
    const next = ordered[i + 1];
    if (next) return make(next.remoteId, 'next');
  }
  const unfinished = played.find((p) => !p.finished);
  if (unfinished) return make(unfinished.episodeRemoteId!, 'continue');
  return make(ordered[0]!.remoteId, 'play');
}
