import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { EpisodeDetail } from '@tv/shared';
import UpNext from './UpNext.svelte';

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const doors: EpisodeDetail = { remoteId: '113', title: 'Doors', episodeNum: 3, durationSec: 1860, imageUrl: null, airDate: null, quality: null };
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const advance = (ms: number) => {
  vi.advanceTimersByTime(ms);
  flushSync();
};

test('counts down and plays at 0', () => {
  const onPlay = vi.fn();
  app = mount(UpNext, { target: document.body, props: { next: doors, season: 3, onPlay, onCancel: vi.fn() } });
  flushSync();
  const card = document.querySelector('.up-next')!;
  expect(card.querySelector('.label')?.textContent).toBe('Up next · S3 E3');
  expect(card.querySelector('.title')?.textContent).toBe('Doors');
  expect(button('Play in')?.textContent).toBe('Play in 5');
  advance(1000);
  expect(button('Play in')?.textContent).toBe('Play in 4');
  advance(3999);
  expect(onPlay).not.toHaveBeenCalled();
  advance(1);
  expect(onPlay).toHaveBeenCalledTimes(1);
  advance(5000);
  expect(onPlay).toHaveBeenCalledTimes(1);
});

test('cancel stops it', () => {
  const onPlay = vi.fn();
  const onCancel = vi.fn();
  app = mount(UpNext, { target: document.body, props: { next: doors, seconds: 3, onPlay, onCancel } });
  flushSync();
  expect(document.querySelector('.label')?.textContent).toBe('Up next · Episode 3'); // no season given
  advance(1000);
  button('Cancel')!.click();
  flushSync();
  expect(onCancel).toHaveBeenCalledTimes(1);
  advance(10_000);
  expect(onPlay).not.toHaveBeenCalled();

  // Play in N plays at once.
  unmount(app);
  document.body.innerHTML = '';
  app = mount(UpNext, { target: document.body, props: { next: doors, onPlay, onCancel } });
  flushSync();
  button('Play in 5')!.click();
  expect(onPlay).toHaveBeenCalledTimes(1);
  advance(10_000);
  expect(onPlay).toHaveBeenCalledTimes(1);
});
