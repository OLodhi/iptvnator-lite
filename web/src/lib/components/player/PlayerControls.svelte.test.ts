import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PlayerControls from './PlayerControls.svelte';

let app: ReturnType<typeof mount> | undefined;
let props: Record<string, unknown>;

function makeState(over: Record<string, unknown> = {}) {
  return { paused: false, ended: false, waiting: false, muted: false, positionSec: 100, durationSec: 600, window: null, behindSec: 0, error: null, destroy() {}, ...over };
}

function setup(over: Record<string, unknown> = {}) {
  const p = $state<Record<string, unknown>>({
    state: makeState(),
    mode: 'vod', title: 'Heat', fullscreen: false,
    caps: { pip: false, airplay: false }, tracks: { audio: false, subtitles: false },
    holding: false, durationSec: 600,
    onTogglePlay: vi.fn(), onSkip: vi.fn(), onSeek: vi.fn(), onPip: vi.fn(), onAirPlay: vi.fn(), onToggleMute: vi.fn(),
    onFullscreen: vi.fn(), onTracks: vi.fn(), onBack: vi.fn(),
    ...over,
  });
  props = p;
  app = mount(PlayerControls, { target: document.body, props: p as never });
  flushSync();
  const surface = document.querySelector('.surface') as HTMLElement;
  surface.getBoundingClientRect = () => ({ left: 0, right: 900, width: 900, top: 0, bottom: 500, height: 500, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return surface;
}
const root = () => document.querySelector('.controls') as HTMLElement;
const hidden = () => root().classList.contains('hidden');
const tap = (surface: HTMLElement, x: number) => { surface.dispatchEvent(new MouseEvent('click', { clientX: x, bubbles: true })); flushSync(); };
const advance = (ms: number) => { vi.advanceTimersByTime(ms); flushSync(); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('controls hide after 3 s and stay while paused, scrubbing or holding', () => {
  setup();
  expect(hidden()).toBe(false);
  advance(2999);
  expect(hidden()).toBe(false);
  advance(1);
  expect(hidden()).toBe(true);

  // Paused: stays.
  props.state = makeState({ paused: true });
  flushSync();
  expect(hidden()).toBe(false);
  advance(10_000);
  expect(hidden()).toBe(false);

  // Holding (sheet open): stays.
  props.state = makeState();
  props.holding = true;
  flushSync();
  advance(10_000);
  expect(hidden()).toBe(false);
  props.holding = false;
  flushSync();
  advance(3000);
  expect(hidden()).toBe(true);

  // Scrubbing: stays until released.
  const surface = document.querySelector('.surface') as HTMLElement;
  tap(surface, 450);
  expect(hidden()).toBe(false);
  const track = document.querySelector('.track') as HTMLElement;
  track.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} }) as DOMRect;
  track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, bubbles: true }));
  flushSync();
  advance(10_000);
  expect(hidden()).toBe(false);
  track.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, bubbles: true }));
  flushSync();
  advance(3000);
  expect(hidden()).toBe(true);
});

test('single tap toggles', () => {
  const surface = setup();
  tap(surface, 450);
  expect(hidden()).toBe(true);
  advance(400);
  tap(surface, 450);
  expect(hidden()).toBe(false);
});

test('double-tap right skips +10 and left −10', () => {
  const onSkip = vi.fn();
  const surface = setup({ onSkip });
  tap(surface, 800);
  advance(200);
  tap(surface, 800);
  expect(onSkip).toHaveBeenLastCalledWith(10);
  expect(document.querySelector('.flash')?.textContent).toBe('+10 s');
  expect(hidden()).toBe(false);
  advance(1000);
  tap(surface, 50);
  advance(299);
  tap(surface, 50);
  expect(onSkip).toHaveBeenLastCalledWith(-10);
  expect(document.querySelector('.flash')?.textContent).toBe('−10 s');
  expect(onSkip).toHaveBeenCalledTimes(2);
  // Too slow: not a double tap.
  advance(1000);
  tap(surface, 800);
  advance(301);
  tap(surface, 800);
  expect(onSkip).toHaveBeenCalledTimes(2);
});

test('fullscreen shows the title, channel buttons and track chips', () => {
  const onChannel = vi.fn();
  const onTracks = vi.fn();
  setup({ onChannel, onTracks, subtitle: 'Drama', nextLabel: 'Next · 21:00 News', tracks: { audio: true, subtitles: true } });
  expect(document.querySelector('.title-row')).toBeNull();
  expect(document.querySelector('[aria-label="Next channel"]')).toBeNull();
  expect(document.querySelector('.chip')).toBeNull();
  props.fullscreen = true;
  flushSync();
  expect(document.querySelector('.title-row')?.textContent).toContain('Heat');
  expect(document.querySelector('.next')?.textContent).toBe('Next · 21:00 News');
  (document.querySelector('[aria-label="Next channel"]') as HTMLElement).click();
  (document.querySelector('[aria-label="Previous channel"]') as HTMLElement).click();
  expect(onChannel.mock.calls).toEqual([[1], [-1]]);
  const chips = [...document.querySelectorAll('.chip')] as HTMLElement[];
  expect(chips).toHaveLength(2);
  chips[1]!.click();
  expect(onTracks).toHaveBeenCalledWith('audio');
  chips[0]!.click();
  expect(onTracks).toHaveBeenCalledWith('subtitles');
});

test('unsupported PiP and AirPlay render nothing', () => {
  setup();
  expect(document.querySelector('[aria-label="Picture in picture"]')).toBeNull();
  expect(document.querySelector('[aria-label="AirPlay"]')).toBeNull();
  props.caps = { pip: true, airplay: true };
  flushSync();
  expect(document.querySelector('[aria-label="Picture in picture"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="AirPlay"]')).not.toBeNull();
});

test('live mode shows the pill with the state behindSec and a scrub bar', () => {
  const onGoLive = vi.fn();
  setup({ mode: 'live', onGoLive, state: makeState({ durationSec: null, window: { startSec: 0, endSec: 600 }, behindSec: 150, positionSec: 450 }) });
  const pill = document.querySelector('[aria-label="Go to live"]') as HTMLElement;
  expect(pill.textContent?.trim()).toBe('● −2:30');
  pill.click();
  expect(onGoLive).toHaveBeenCalled();
  expect(document.querySelector('[role="slider"]')).not.toBeNull();
});
