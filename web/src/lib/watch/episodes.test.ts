import { expect, test } from 'vitest';
import type { EpisodeDetail, SeasonDetail } from '@tv/shared';
import { nextEpisode, seasonOf } from './episodes.ts';

const ep = (remoteId: string, episodeNum: number): EpisodeDetail => ({
  remoteId, title: `Episode ${remoteId}`, episodeNum, durationSec: 1800, imageUrl: null, airDate: null, quality: null,
});
const season = (n: number, episodes: EpisodeDetail[]): SeasonDetail => ({ season: n, name: `Season ${n}`, coverUrl: null, episodes });

// Out of order, as a provider may send them: season 2 first, and season 1's episodes backwards.
const seasons = [season(2, [ep('121', 1)]), season(1, [ep('112', 2), ep('111', 1)])];

test('next crosses seasons', () => {
  expect(nextEpisode(seasons, '111')?.remoteId).toBe('112');
  expect(nextEpisode(seasons, '112')?.remoteId).toBe('121');
  expect(seasonOf(seasons, '112')?.season).toBe(1);
  expect(seasonOf(seasons, '121')?.season).toBe(2);
});

test('last has none', () => {
  expect(nextEpisode(seasons, '121')).toBeNull();
  expect(nextEpisode(seasons, 'unknown')).toBeNull();
  expect(seasonOf(seasons, 'unknown')).toBeNull();
  expect(nextEpisode([], '111')).toBeNull();
});

test('specials come last in watching order', () => {
  const withSpecials = [season(0, [ep('100', 1)]), ...seasons];
  expect(nextEpisode(withSpecials, '112')?.remoteId).toBe('121'); // season 1 into season 2, not into the specials
  expect(nextEpisode(withSpecials, '121')?.remoteId).toBe('100'); // the specials follow the last season
  expect(nextEpisode(withSpecials, '100')).toBeNull();
});
