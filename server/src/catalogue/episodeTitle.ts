import type { Quality } from '@tv/shared';

// "S01E01" or "1x05", on its own (not inside a longer word or number).
const EPISODE_TOKEN = /(?<![A-Za-z0-9])(?:S\d{1,2}E\d{1,3}|\d{1,2}x\d{1,3})(?![A-Za-z0-9])/i;

/**
 * "NL - THE BEAR (2022) - S01E01 - System" -> "System". Providers prefix episode titles with the show name and an
 * SxxEyy token; everything up to and including the token goes, and so do the separators after it. A title without a
 * token is kept as is, and an empty result falls back to "Episode n".
 */
export function cleanEpisodeTitle(raw: string, episodeNum: number): string {
  const m = EPISODE_TOKEN.exec(raw);
  const rest = m ? raw.slice(m.index + m[0].length).replace(/^[\s.:-]+/, '') : raw;
  return rest.trim() || `Episode ${episodeNum}`;
}

/** A badge for the episode list; null when the picture is below HD or its size is unknown. */
export function qualityLabel(width: number | null, height: number | null): Quality | null {
  if ((height ?? 0) >= 2000 || (width ?? 0) >= 3800) return '4K';
  if ((height ?? 0) >= 700 || (width ?? 0) >= 1270) return 'HD';
  return null;
}
