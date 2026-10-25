import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { EpisodeDetail, SeasonDetail } from '@tv/shared';
import SeasonSheet from './SeasonSheet.svelte';

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

const ep = (remoteId: string, episodeNum: number): EpisodeDetail => ({
  remoteId, title: `Episode ${remoteId}`, episodeNum, durationSec: 1800, imageUrl: null, airDate: null, quality: null,
});
const season = (n: number, name: string, count: number): SeasonDetail => ({
  season: n, name, coverUrl: null, episodes: Array.from({ length: count }, (_, i) => ep(`${n}-${i + 1}`, i + 1)),
});

test('watched counts', () => {
  const seasons = [season(1, 'Season 1', 8), season(3, 'Season 3', 10), season(0, 'Specials', 1)];
  const watched: Record<number, number> = { 1: 8, 3: 2, 0: 0 };
  const onPick = vi.fn();
  const onClose = vi.fn();
  app = mount(SeasonSheet, {
    target: document.body,
    props: { open: true, seasons, selected: 3, watchedCount: (s: SeasonDetail) => watched[s.season]!, onPick, onClose },
  });
  flushSync();

  expect(document.querySelector('.sheet-title')?.textContent).toBe('Choose a season');
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.sheet-action:not(.cancel)')];
  expect(rows.map((b) => b.textContent)).toEqual([
    'Season 1 · 8 episodes · watched',
    '✓Season 3 · 2 of 10 watched',
    'Specials · 1 episode',
  ]);
  expect(rows.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);

  rows[2]!.click();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onPick).toHaveBeenCalledWith(0);
});
