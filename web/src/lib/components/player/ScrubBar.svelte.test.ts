import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ScrubBar from './ScrubBar.svelte';

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

function setup(props: Record<string, unknown>) {
  app = mount(ScrubBar, { target: document.body, props: { positionSec: 0, onSeek: vi.fn(), ...props } as never });
  flushSync();
  const track = document.querySelector('.track') as HTMLElement;
  // 1000 px wide at x = 0, so clientX is the pixel offset.
  track.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return track;
}
const fire = (el: Element, type: string, x: number) => el.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, cancelable: true }));

test('vod scrub seeks on release', () => {
  const onSeek = vi.fn();
  const onScrubbing = vi.fn();
  const track = setup({ mode: 'vod', durationSec: 600, positionSec: 0, onSeek, onScrubbing });
  fire(track, 'pointerdown', 250);
  expect(onScrubbing).toHaveBeenLastCalledWith(true);
  fire(track, 'pointermove', 500);
  expect(onSeek).not.toHaveBeenCalled();
  fire(track, 'pointerup', 500);
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(300);
  expect(onScrubbing).toHaveBeenLastCalledWith(false);
});

test('live scrub is clamped to the window', () => {
  const onSeek = vi.fn();
  // Programme 1000..2000; window 1200..1800 shaded and the only seekable part.
  const track = setup({
    mode: 'live', positionSec: 1700, onSeek,
    programme: { startSec: 1000, stopSec: 2000 }, window: { startSec: 1200, endSec: 1800 },
  });
  fire(track, 'pointerdown', 100);
  fire(track, 'pointerup', 100);
  expect(onSeek).toHaveBeenLastCalledWith(1200);
  fire(track, 'pointerdown', 950);
  fire(track, 'pointerup', 950);
  expect(onSeek).toHaveBeenLastCalledWith(1800);
  fire(track, 'pointerdown', 500);
  fire(track, 'pointerup', 500);
  expect(onSeek).toHaveBeenLastCalledWith(1500);
  expect((document.querySelector('.window') as HTMLElement).style.left).toBe('20%');
});

test('live without a programme spans the window', () => {
  const onSeek = vi.fn();
  const track = setup({ mode: 'live', positionSec: 1100, onSeek, window: { startSec: 1000, endSec: 1600 } });
  fire(track, 'pointerdown', 500);
  fire(track, 'pointerup', 500);
  expect(onSeek).toHaveBeenCalledWith(1300);
});
