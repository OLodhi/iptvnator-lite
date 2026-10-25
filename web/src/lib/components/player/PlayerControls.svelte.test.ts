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
  expect(document.querySelector('[aria-label="Back"]')).toBeNull(); // upright, the page's top bar has the one Back
  props.fullscreen = true;
  flushSync();
  expect(document.querySelector('[aria-label="Back"]')).not.toBeNull();
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

test('covered disables the surface gestures, hides the transport and keeps the controls up', () => {
  const onSkip = vi.fn();
  const surface = setup({ onSkip, covered: true });
  expect(root().classList.contains('covered')).toBe(true);
  advance(10_000);
  expect(hidden()).toBe(false);
  tap(surface, 450);
  expect(hidden()).toBe(false);
  tap(surface, 800);
  advance(100);
  tap(surface, 800);
  expect(onSkip).not.toHaveBeenCalled();
  expect(document.querySelector('.flash')).toBeNull();

  props.covered = false;
  flushSync();
  expect(root().classList.contains('covered')).toBe(false);
  advance(400);
  tap(surface, 800);
  advance(100);
  tap(surface, 800);
  expect(onSkip).toHaveBeenCalledWith(10);
});

test('⤢ says what it does, and is left out without a handler', () => {
  const onFullscreen = vi.fn();
  setup({ onFullscreen });
  const button = () => document.querySelector<HTMLElement>('.bar-row [aria-label$="ullscreen"]');
  expect(button()?.getAttribute('aria-label')).toBe('Fullscreen');
  props.fullscreen = true;
  flushSync();
  expect(button()?.getAttribute('aria-label')).toBe('Exit fullscreen');
  button()!.click();
  expect(onFullscreen).toHaveBeenCalledTimes(1);
  props.onFullscreen = undefined; // sideways: turning the phone back is the way out
  flushSync();
  expect(button()).toBeNull();
});

test('channel up and down stay usable while a new channel starts', () => {
  const onChannel = vi.fn();
  setup({ mode: 'live', onChannel, onGoLive: vi.fn(), fullscreen: true, covered: true });
  const next = document.querySelector<HTMLElement>('[aria-label="Next channel"]')!;
  expect(next.closest('.center')).toBeNull(); // the transport hides under a cover; the channel buttons do not
  next.click();
  expect(onChannel).toHaveBeenCalledWith(1);
});

test('the live bar puts the stream on the programme clock', () => {
  const onSeek = vi.fn();
  // The stream's own time 0..600 is 19:50..20:00 on the clock; the programme runs 19:00..21:00.
  const at = (h: number, m: number) => Date.UTC(2026, 9, 25, h, m) / 1000;
  setup({
    mode: 'live', onSeek, onGoLive: vi.fn(), liveShiftSec: at(19, 50), programme: { startSec: at(19, 0), stopSec: at(21, 0) },
    state: makeState({ durationSec: null, window: { startSec: 0, endSec: 600 }, positionSec: 300, behindSec: 300 }),
  });
  const slider = document.querySelector('[role="slider"]')!;
  expect(slider.getAttribute('aria-valuemin')).toBe(String(at(19, 0)));
  expect(slider.getAttribute('aria-valuemax')).toBe(String(at(21, 0)));
  expect(slider.getAttribute('aria-valuenow')).toBe(String(at(19, 55)));
  const track = document.querySelector('.track') as HTMLElement;
  track.getBoundingClientRect = () => ({ left: 0, right: 1200, width: 1200, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} }) as DOMRect;
  // 19:52 is 520 of 1200 px along the programme; it is 120 s into the stream.
  track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 520, bubbles: true }));
  track.dispatchEvent(new MouseEvent('pointerup', { clientX: 520, bubbles: true }));
  expect(onSeek).toHaveBeenCalledWith(120);
});

test('catch-up of a programme still airing has Watch live beside the bar', () => {
  const onWatchLive = vi.fn();
  setup({ onWatchLive });
  expect(document.querySelector('[aria-label="Go to live"]')).toBeNull();
  const pill = document.querySelector<HTMLElement>('.bar-row .watch-live')!;
  expect(pill.textContent?.trim()).toBe('● Watch live');
  pill.click();
  expect(onWatchLive).toHaveBeenCalledTimes(1);
  props.onWatchLive = undefined;
  flushSync();
  expect(document.querySelector('.watch-live')).toBeNull();
});
