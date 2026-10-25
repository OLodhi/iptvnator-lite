import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { EpisodeDetail, SavedPosition } from '@tv/shared';
import EpisodeRow from './EpisodeRow.svelte';

const apps: ReturnType<typeof mount>[] = [];
afterEach(() => {
  apps.splice(0).forEach((a) => unmount(a));
  document.body.innerHTML = '';
});

const ep = (over: Partial<EpisodeDetail> = {}): EpisodeDetail => ({
  remoteId: '112', title: 'Next', episodeNum: 2, durationSec: 1980, imageUrl: '/api/art/11/episode-112', airDate: null, quality: null, ...over,
});
const saved = (over: Partial<SavedPosition>): SavedPosition => ({
  episodeRemoteId: '112', positionSec: 0, durationSec: null, finished: false, manual: false, updatedAt: 1, ...over,
});

/** Mounts a row in its own box and returns the box. */
function row(props: { episode: EpisodeDetail; saved: SavedPosition | null; current?: boolean }): HTMLElement {
  const target = document.body.appendChild(document.createElement('div'));
  apps.push(mount(EpisodeRow, { target, props: { itemId: 11, href: `/watch?item=11&episode=${props.episode.remoteId}`, ...props } }));
  flushSync();
  return target;
}
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

test('watched shows ✓; started shows progress and min left; quality badge', () => {
  // Marked watched by hand, with no known length: positionSec 0, but finished.
  const watched = row({ episode: ep({ remoteId: '111', episodeNum: 1, title: 'Tomorrow' }), saved: saved({ episodeRemoteId: '111', finished: true, manual: true }) });
  expect(text(watched.querySelector('.n'))).toBe('1 · Tomorrow');
  expect(text(watched.querySelector('.s'))).toBe('watched');
  expect(text(watched.querySelector('.thumb .done'))).toBe('✓');
  expect(watched.querySelector('.thumb .prog')).toBeNull();
  expect(watched.querySelector('a')!.getAttribute('href')).toBe('/watch?item=11&episode=111');
  expect(watched.querySelector('.thumb img')!.getAttribute('src')).toBe('/api/art/11/episode-112');

  // 18 of 33 minutes in.
  const started = row({ episode: ep({ quality: 'HD' }), saved: saved({ positionSec: 1080, durationSec: 1980 }), current: true });
  expect(text(started.querySelector('.s'))).toBe('15 min left HD');
  expect(text(started.querySelector('.badge'))).toBe('HD');
  expect((started.querySelector('.thumb .prog i') as HTMLElement).style.width).toBe('55%');
  expect(started.querySelector('.thumb .done')).toBeNull();
  expect(text(started.querySelector('.flag'))).toBe('Playing');
  expect(started.querySelector('a')!.getAttribute('aria-current')).toBe('true');

  // Not started: its length, and a 4K badge.
  const fresh = row({ episode: ep({ remoteId: '113', episodeNum: 3, title: 'Doors', durationSec: 1860, quality: '4K' }), saved: null });
  expect(text(fresh.querySelector('.s'))).toBe('31 min 4K');
  expect(fresh.querySelector('.thumb .prog, .thumb .done, .flag')).toBeNull();
  expect(fresh.querySelector('a')!.hasAttribute('aria-current')).toBe(false);

  // No length and no quality: nothing to say.
  const bare = row({ episode: ep({ remoteId: '114', durationSec: null, imageUrl: null }), saved: null });
  expect(text(bare.querySelector('.s'))).toBe('');
  expect(bare.querySelector('.badge')).toBeNull();
  expect(bare.querySelector('.thumb .tile')).not.toBeNull();
});
