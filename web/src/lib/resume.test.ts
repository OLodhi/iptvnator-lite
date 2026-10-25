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

test('pickTarget: latest finished continues with the next episode, across seasons', () => {
  expect(pickTarget(seasons, [pos('s1e1', 9, true), pos('s1e2', 3)])).toEqual({ episodeRemoteId: 's1e2', label: 'S1 E2', mode: 'continue' });
  expect(pickTarget(seasons, [pos('s1e2', 9, true)])).toEqual({ episodeRemoteId: 's2e1', label: 'S2 E1', mode: 'continue' });
});

test('pickTarget: latest finished on the last episode falls back to latest unfinished, else play first', () => {
  expect(pickTarget(seasons, [pos('s2e1', 9, true), pos('s1e2', 3)])).toEqual({ episodeRemoteId: 's1e2', label: 'S1 E2', mode: 'continue' });
  expect(pickTarget(seasons, [pos('s2e1', 9, true)])).toEqual({ episodeRemoteId: 's1e1', label: 'S1 E1', mode: 'play' });
});
