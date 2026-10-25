import { expect, test } from 'vitest';
import type { SavedPosition, Season } from '@tv/shared';
import { pickResume, pickTarget } from './resume.ts';

const ep = (remoteId: string, episodeNum: number) => ({ remoteId, title: remoteId, episodeNum, durationSec: 1000 });
const seasons: Season[] = [
  { season: 2, episodes: [ep('s2e1', 1)] },
  { season: 1, episodes: [ep('s1e2', 2), ep('s1e1', 1)] },
];
const pos = (episodeRemoteId: string | null, updatedAt: number, finished = false, positionSec = 100): SavedPosition => ({
  episodeRemoteId, positionSec, durationSec: 1000, finished, manual: false, updatedAt,
});
/** Marked watched by hand: finished, and (with no known length) at position 0. */
const marked = (episodeRemoteId: string, updatedAt: number): SavedPosition => ({ ...pos(episodeRemoteId, updatedAt, true, 0), manual: true });

test('pickResume: movie (null episode) picks the unfinished whole-title position', () => {
  const p = pos(null, 1);
  expect(pickResume([pos('e1', 2), p], null)).toBe(p);
});

test('pickResume ignores finished, under-5-s and other-episode rows', () => {
  expect(pickResume([pos('e1', 1, true)], 'e1')).toBeNull();
  expect(pickResume([pos('e1', 1, false, 4)], 'e1')).toBeNull();
  expect(pickResume([pos('e2', 1)], 'e1')).toBeNull();
  expect(pickResume([], null)).toBeNull();
});

test('pickTarget: no positions plays the first episode in season/episode order', () => {
  expect(pickTarget(seasons, [])).toEqual({ episodeRemoteId: 's1e1', label: 'S1 E1', mode: 'play' });
  expect(pickTarget([], [])).toBeNull();
});

test('pickTarget: latest unfinished continues', () => {
  expect(pickTarget(seasons, [pos('s1e1', 1), pos('s1e2', 5)])).toEqual({ episodeRemoteId: 's1e2', label: 'S1 E2', mode: 'continue' });
});

test('next mode after a finished real episode', () => {
  expect(pickTarget(seasons, [pos('s1e1', 9, true), pos('s1e2', 3)])).toEqual({ episodeRemoteId: 's1e2', label: 'S1 E2', mode: 'next' });
  // Across seasons.
  expect(pickTarget(seasons, [pos('s1e2', 9, true)])).toEqual({ episodeRemoteId: 's2e1', label: 'S2 E1', mode: 'next' });
});

test('pickTarget: latest finished on the last episode falls back to latest unfinished, else play first', () => {
  expect(pickTarget(seasons, [pos('s2e1', 9, true), pos('s1e2', 3)])).toEqual({ episodeRemoteId: 's1e2', label: 'S1 E2', mode: 'continue' });
  expect(pickTarget(seasons, [pos('s2e1', 9, true)])).toEqual({ episodeRemoteId: 's1e1', label: 'S1 E1', mode: 'play' });
});

test('manual marks do not move the target', () => {
  // Design 7.4: halfway through S2 E1, then season 1 marked watched: still Continue S2 E1.
  expect(pickTarget(seasons, [pos('s2e1', 5), marked('s1e1', 9), marked('s1e2', 9)])).toEqual({
    episodeRemoteId: 's2e1', label: 'S2 E1', mode: 'continue',
  });
  // S1 E1 played to the end, then S2 E1 marked later: Play next still follows what was played.
  expect(pickTarget(seasons, [pos('s1e1', 5, true), marked('s2e1', 9)])).toEqual({ episodeRemoteId: 's1e2', label: 'S1 E2', mode: 'next' });
  // Nothing played: a mark is never where you are, so Play starts at the first episode not yet watched.
  expect(pickTarget(seasons, [marked('s1e1', 9)])).toEqual({ episodeRemoteId: 's1e2', label: 'S1 E2', mode: 'play' });
});

test('marking the episode you are halfway through offers the next unwatched one', () => {
  const bear: Season[] = [
    { season: 1, episodes: [ep('s1e1', 1)] },
    { season: 3, episodes: [ep('s3e1', 1), ep('s3e2', 2), ep('s3e3', 3)] },
  ];
  // S3 E1 played to the end, S3 E2 halfway: Continue S3 E2.
  expect(pickTarget(bear, [pos('s3e1', 1, true), pos('s3e2', 5)])).toEqual({ episodeRemoteId: 's3e2', label: 'S3 E2', mode: 'continue' });
  // Then S3 E2 marked: the server finishes the real row in place (still real, same time), so it is the anchor.
  expect(pickTarget(bear, [pos('s3e1', 1, true), pos('s3e2', 5, true, 1000)])).toEqual({ episodeRemoteId: 's3e3', label: 'S3 E3', mode: 'next' });
  // A row the mark made manual instead: the anchor is S3 E1, and the watched S3 E2 is skipped.
  expect(pickTarget(bear, [pos('s3e1', 1, true), marked('s3e2', 9)])).toEqual({ episodeRemoteId: 's3e3', label: 'S3 E3', mode: 'next' });
});

test('Play next skips watched episodes', () => {
  // S1 E1 played to the end, S1 E2 marked watched: S2 E1 is next.
  expect(pickTarget(seasons, [pos('s1e1', 5, true), marked('s1e2', 9)])).toEqual({ episodeRemoteId: 's2e1', label: 'S2 E1', mode: 'next' });
  // Watched by playing counts too.
  expect(pickTarget(seasons, [pos('s1e1', 5, true), pos('s1e2', 3, true)])).toEqual({ episodeRemoteId: 's2e1', label: 'S2 E1', mode: 'next' });
});

test('no anchor plays the first unwatched episode', () => {
  // A fresh series with season 1 marked watched.
  expect(pickTarget(seasons, [marked('s1e1', 9), marked('s1e2', 9)])).toEqual({ episodeRemoteId: 's2e1', label: 'S2 E1', mode: 'play' });
  // Every episode watched: the first episode.
  expect(pickTarget(seasons, [marked('s1e1', 9), marked('s1e2', 9), marked('s2e1', 9)])).toEqual({
    episodeRemoteId: 's1e1', label: 'S1 E1', mode: 'play',
  });
  expect(pickTarget(seasons, [pos('s2e1', 9, true), marked('s1e1', 9), marked('s1e2', 9)])).toEqual({
    episodeRemoteId: 's1e1', label: 'S1 E1', mode: 'play',
  });
});

test('specials come last: a fresh series plays S1 E1, and they follow the last season', () => {
  const withSpecials: Season[] = [{ season: 0, episodes: [ep('sp1', 1)] }, ...seasons];
  expect(pickTarget(withSpecials, [])).toEqual({ episodeRemoteId: 's1e1', label: 'S1 E1', mode: 'play' });
  expect(pickTarget(withSpecials, [pos('s2e1', 9, true)])).toEqual({ episodeRemoteId: 'sp1', label: 'S0 E1', mode: 'next' });
  expect(pickTarget(withSpecials, [pos('sp1', 9, true)])).toEqual({ episodeRemoteId: 's1e1', label: 'S1 E1', mode: 'play' });
});
