import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, PlayResponse, SavedPosition } from '@tv/shared';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/watch?item=7&t=600') }));
const api = vi.hoisted(() => vi.fn());
const attachStream = vi.hoisted(() => vi.fn((_v: HTMLVideoElement, _url: string, _opts: object) => ({ destroy: () => {}, showSubtitles: () => {} })));
const heartbeats = vi.hoisted(() => [] as { onGone: () => void }[]);
type BeforeNav = (nav: { to: { url: URL } | null }) => void;
const nav = vi.hoisted(() => ({ goto: vi.fn(async (_u: string) => {}), before: undefined as BeforeNav | undefined }));
const tick = $state({ n: 0 }); // bumped to make the mocked page.url reactive, as the real one is
vi.mock('$app/state', () => ({
  page: {
    get url() {
      void tick.n;
      return route.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto, beforeNavigate: (cb: BeforeNav) => (nav.before = cb) }));
vi.mock('hls.js', () => ({ default: {} }));
vi.mock('$lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('$lib/api')>()), api }));
const me = vi.hoisted(() => ({ positions: vi.fn(async (_id: number): Promise<SavedPosition[]> => []), reportPosition: vi.fn(async () => {}) }));
vi.mock('$lib/me', () => me);
const released = vi.hoisted(() => vi.fn(async (_s: string, _c: string) => {}));
vi.mock('$lib/session', () => ({
  releaseSession: released,
  startHeartbeat: vi.fn((_s: string, _c: string, opts: { onGone: () => void }) => {
    heartbeats.push(opts);
    return () => {};
  }),
}));
vi.mock('$lib/clientId', () => ({ getClientId: () => 'cid' }));
vi.mock('$lib/player/attach', () => ({ attachStream }));
const sys = vi.hoisted(() => ({ pip: false, airplay: false }));
vi.mock('$lib/player/system', () => ({
  canPip: () => sys.pip,
  canAirPlay: () => sys.airplay,
  togglePip: async () => {},
  showAirPlay: () => {},
  setNowPlaying: () => {},
}));

import { ApiClientError } from '$lib/api';
import Watch from './+page.svelte';

let app: ReturnType<typeof mount> | undefined;
// 22:13:20 UTC on 1 January 1970: during liveItem's News at Ten (22:00–23:00).
const NOW_MS = 80_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  api.mockReset();
  attachStream.mockClear();
  heartbeats.length = 0;
  nav.goto.mockClear();
  released.mockClear();
  me.positions.mockClear();
  me.reportPosition.mockClear();
  sys.pip = false;
  sys.airplay = false;
  // jsdom has no media playback.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  route.url = new URL('http://localhost/watch?item=7&t=600');
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'matchMedia');
});

/** Fakes the page's timeouts too, from NOW_MS. */
function fakeTimeouts() {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW_MS);
}

/** A touch screen that can be turned sideways. */
function fakeScreen() {
  const listeners = new Set<() => void>();
  const mql = {
    matches: false,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia;
  return {
    rotate(landscape: boolean) {
      mql.matches = landscape;
      listeners.forEach((fn) => fn());
      flushSync();
    },
  };
}

const playCalls = () => api.mock.calls.filter(([path]) => path === '/api/play');
const startAtOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string).startAtSec as number;
const mediaPlay = () => vi.mocked(HTMLMediaElement.prototype.play);
const video = () => document.querySelector('video')!;
const states = () => document.querySelector('.states');
const fullscreen = () => document.querySelector('.watch')!.classList.contains('fullscreen');
const controlsHidden = () => document.querySelector('.controls')!.classList.contains('hidden');
function tapVideo() {
  document.querySelector('.surface')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
}
/** The stream has started playing. */
function playing(v: HTMLVideoElement) {
  Object.defineProperty(v, 'paused', { configurable: true, get: () => false });
  v.dispatchEvent(new Event('playing'));
  flushSync();
}

/** Resumes at 0:10:00, watches until currentTime says `currentTime`, loses the session, then taps restart. */
async function resumeThenRestart(response: PlayResponse, currentTime: number) {
  api.mockImplementation(async (path: string) => (path === '/api/play' ? response : undefined));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  const v = video();
  Object.defineProperty(v, 'readyState', { get: () => HTMLMediaElement.HAVE_METADATA }); // jsdom never opens media
  v.currentTime = currentTime;
  heartbeats[0]!.onGone();
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Tap to restart'))!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
}

test('a direct resume seeks the file, and a restart resumes at the absolute position', async () => {
  const direct: PlayResponse = { sessionId: 's1', mode: 'direct', url: '/api/sessions/s1/cid/direct', durationSec: 3000, startAtSec: 600, tracks: null };
  await resumeThenRestart(direct, 610); // the file was seeked to 600, so currentTime is already absolute
  expect(attachStream.mock.calls[0]).toEqual([expect.any(HTMLVideoElement), direct.url, expect.objectContaining({ startAtSec: 600 })]);
  expect(playCalls().map(startAtOf)).toEqual([600, 610]);
});

test('an HLS resume asks for no seek, and a restart resumes at the absolute position', async () => {
  const hls: PlayResponse = { sessionId: 's1', mode: 'hls', url: '/api/sessions/s1/cid/index.m3u8', durationSec: 3000, startAtSec: 600, tracks: null };
  await resumeThenRestart(hls, 10); // the session starts at 600, so currentTime counts from there
  expect(attachStream.mock.calls[0]![2]).not.toHaveProperty('startAtSec');
  expect(playCalls().map(startAtOf)).toEqual([600, 610]);
});

const catchupRes: PlayResponse = { sessionId: 'c1', mode: 'hls', url: '/api/sessions/c1/cid/index.m3u8', durationSec: 3600, startAtSec: 0, tracks: null };
const liveRes: PlayResponse = { sessionId: 'l1', mode: 'hls', url: '/api/sessions/l1/cid/index.m3u8', durationSec: null, startAtSec: 0, tracks: null };
const movieRes: PlayResponse = { sessionId: 'm1', mode: 'hls', url: '/api/sessions/m1/cid/index.m3u8', durationSec: 3000, startAtSec: 600, tracks: null };
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const liveItem = (over: Partial<CatalogItem> = {}) =>
  ({
    id: 7,
    kind: 'live',
    displayName: 'BBC One',
    logoUrl: '/api/logos/7',
    catchupDays: 3,
    now: { title: 'News at Ten', startSec: 79200, stopSec: 82800 },
    ...over,
  }) as CatalogItem;
const movieItem = (over: Partial<CatalogItem> = {}) =>
  ({ id: 5, kind: 'movie', displayName: 'Heat', logoUrl: '/api/logos/5', catchupDays: null, ...over }) as CatalogItem;
const buttonWith = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
/** The programme on now under the video: "title start–stop", or null when there is none. */
function onNowLine(): string | null {
  const el = document.querySelector('.on-now');
  if (!el) return null;
  return `${el.querySelector('.prog')!.textContent} ${[...el.querySelectorAll('time')].map((t) => t.textContent).join('–')}`;
}

function serve(play: PlayResponse, item: CatalogItem | Error) {
  api.mockImplementation(async (path: string) => {
    if (path === '/api/play') return play;
    if (item instanceof Error) throw item;
    return item;
  });
}

test('video has no native controls and our controls render', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  const v = video();
  expect(v.hasAttribute('controls')).toBe(false);
  expect(v.hasAttribute('playsinline')).toBe(true);
  expect(v.hasAttribute('autoplay')).toBe(true);
  expect(document.querySelector('.player .controls')).not.toBeNull();
  for (const label of ['Back 10 seconds', 'Play', 'Forward 10 seconds', 'Fullscreen', 'Mute']) {
    expect(document.querySelector(`.controls [aria-label="${label}"]`), label).not.toBeNull();
  }
  expect(document.querySelector('.topbar')?.textContent).toContain('Back');
});

test('a plain item starts once its kind is known: a channel as live, a movie as VOD', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  let answer!: (it: CatalogItem) => void;
  api.mockImplementation((path: string) => (path === '/api/play' ? Promise.resolve(liveRes) : new Promise((r) => (answer = r))));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(me.positions).toHaveBeenCalled());
  await vi.waitFor(() => expect(api.mock.calls.some(([p]) => p === '/api/items/7')).toBe(true));
  await Promise.resolve();
  expect(playCalls()).toHaveLength(0);
  answer(liveItem());
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(attachStream.mock.calls[0]![2]).toMatchObject({ vod: false });
  expect(document.querySelector('[aria-label="Go to live"]')).not.toBeNull();
  unmount(app);
  document.body.innerHTML = '';

  route.url = new URL('http://localhost/watch?item=5&t=600');
  serve(movieRes, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  expect(attachStream.mock.calls[1]![2]).toMatchObject({ vod: true });
  expect(document.querySelector('[aria-label="Go to live"]')).toBeNull();
});

test('Starting shows the logo and name', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  api.mockImplementation((path: string) => (path === '/api/play' ? new Promise(() => {}) : Promise.resolve(liveItem())));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(states()?.textContent).toContain('Starting BBC One…'));
  expect(states()!.querySelector('img')?.getAttribute('src')).toBe('/api/logos/7');
  expect(states()!.querySelector('button')).toBeNull();
});

test('a saved position offers Resume from m:ss or Start over', async () => {
  route.url = new URL('http://localhost/watch?item=5');
  me.positions.mockResolvedValueOnce([{ episodeRemoteId: null, positionSec: 2472, durationSec: 6000, finished: false, manual: false, updatedAt: 1 }]);
  serve({ ...movieRes, startAtSec: 2472 }, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(buttonWith('Resume from 41:12')).toBeDefined());
  expect(buttonWith('Start over')).toBeDefined();
  expect(playCalls()).toHaveLength(0);
  buttonWith('Resume from 41:12')!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(1));
  expect(startAtOf(playCalls()[0]!)).toBe(2472);
  expect(buttonWith('Start over')).toBeUndefined();
});

test('rotating to landscape during Starting does not call play again, and controls are not stuck hidden', async () => {
  fakeTimeouts();
  const screen = fakeScreen();
  route.url = new URL('http://localhost/watch?item=7');
  let answer!: (r: PlayResponse) => void;
  api.mockImplementation((path: string) => (path === '/api/play' ? new Promise((r) => (answer = r)) : Promise.resolve(liveItem())));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(playCalls()).toHaveLength(1));
  const v = video();
  expect(states()?.textContent).toContain('Starting');
  expect(fullscreen()).toBe(false);

  screen.rotate(true);
  expect(fullscreen()).toBe(true);
  answer(liveRes);
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(video()).toBe(v);
  expect(attachStream.mock.calls[0]![0]).toBe(v);

  playing(v);
  expect(states()).toBeNull();
  expect(controlsHidden()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(controlsHidden()).toBe(true);
  tapVideo();
  expect(controlsHidden()).toBe(false);

  screen.rotate(false);
  expect(fullscreen()).toBe(false);
  expect(playCalls()).toHaveLength(1);
  expect(attachStream).toHaveBeenCalledTimes(1);
  expect(mediaPlay()).toHaveBeenCalledTimes(1);
});

test('a sheet open while rotating stays open', async () => {
  fakeTimeouts();
  sys.pip = true;
  sys.airplay = true;
  const screen = fakeScreen();
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  playing(video());
  const sheet = () => document.querySelector('[role="dialog"][aria-label="More"]');
  buttonWith('More')!.click();
  flushSync();
  expect(sheet()?.textContent).toContain('Full screen');

  screen.rotate(true);
  expect(fullscreen()).toBe(true);
  expect(sheet()).not.toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(controlsHidden()).toBe(false); // held while the sheet is open
  expect(playCalls()).toHaveLength(1);

  [...sheet()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
  flushSync();
  expect(sheet()).toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  expect(controlsHidden()).toBe(true);
  tapVideo();
  expect(controlsHidden()).toBe(false);
});

test('⤢ fills the screen and returns, without restarting playback', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  const v = video();
  (document.querySelector('.controls [aria-label="Fullscreen"]') as HTMLElement).click();
  flushSync();
  expect(fullscreen()).toBe(true);
  (document.querySelector('.controls [aria-label="Fullscreen"]') as HTMLElement).click();
  flushSync();
  expect(fullscreen()).toBe(false);
  expect(video()).toBe(v);
  expect(playCalls()).toHaveLength(1);
  expect(attachStream).toHaveBeenCalledTimes(1);
});

test('the one-stream 409 shows the exact copy and no button', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  api.mockImplementation(async (path: string) => {
    if (path === '/api/play') {
      throw new ApiClientError(409, 'PROVIDER_CONNECTION_LIMIT', 'The provider allows 1 connection(s)', { limit: 1, watchingClientIds: ['x'] });
    }
    return liveItem();
  });
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() =>
    expect(document.querySelector('[role=alert]')?.textContent).toBe(
      'Your provider allows 1 stream at a time. Something is already playing on another device.',
    ),
  );
  expect(states()!.querySelector('button')).toBeNull();
});

test('a video error shows the message and Tap to restart', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  playing(video());
  expect(states()).toBeNull();
  video().dispatchEvent(new Event('error'));
  flushSync();
  expect(document.querySelector('[role=alert]')?.textContent).toBe("This video can't be played right now.");
  buttonWith('Tap to restart')!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  expect(states()?.textContent).toContain('Starting');
});

test('autoplay refused shows Tap to play', async () => {
  route.url = new URL('http://localhost/watch?item=5&t=600');
  mediaPlay().mockImplementationOnce(() => Promise.reject(new DOMException('Not allowed', 'NotAllowedError')));
  serve(movieRes, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(buttonWith('Tap to play')).toBeDefined());
  expect(playCalls()).toHaveLength(1);
  buttonWith('Tap to play')!.click();
  expect(mediaPlay()).toHaveBeenCalledTimes(2);
  playing(video());
  expect(states()).toBeNull();
  expect(playCalls()).toHaveLength(1);
});

test('a seek restart keeps showing the target while the new session starts', async () => {
  route.url = new URL('http://localhost/watch?item=5&t=600');
  serve(movieRes, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  playing(video());
  const slider = () => document.querySelector('.controls [role="slider"]')!;
  video().dispatchEvent(new Event('timeupdate'));
  flushSync();
  expect(slider().getAttribute('aria-valuenow')).toBe('600');
  expect(slider().getAttribute('aria-valuemax')).toBe('3000');

  api.mockImplementation((path: string) => (path === '/api/play' ? new Promise(() => {}) : Promise.resolve(movieItem())));
  (document.querySelector('.controls [aria-label="Forward 10 seconds"]') as HTMLElement).click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2)); // nothing past 600 is loaded yet, so the session restarts there
  expect(startAtOf(playCalls()[1]!)).toBe(610);
  video().dispatchEvent(new Event('timeupdate')); // the old source is gone: currentTime is back at 0
  flushSync();
  expect(slider().getAttribute('aria-valuenow')).toBe('610');
});

test('catch-up params play catch-up without resume or progress', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(bodyOf(playCalls()[0]!)).toMatchObject({ itemId: 7, catchup: { startSec: 3600, stopSec: 7200 }, startAtSec: 0 });
  expect(me.positions).not.toHaveBeenCalled();
  const v = video();
  v.currentTime = 30;
  v.dispatchEvent(new Event('pause'));
  v.dispatchEvent(new Event('timeupdate'));
  unmount(app);
  app = undefined;
  expect(me.reportPosition).not.toHaveBeenCalled();
});

test('catch-up shows its label, and not the on-now line', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(document.body.textContent).toContain('↺ Catch-up · News · 01:00–02:00');
  expect(onNowLine()).toBeNull();
  expect(buttonWith('From start')).toBeUndefined();
});

test('invalid from/to play normally', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=7200&to=3600&t=600');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(bodyOf(playCalls()[0]!).catchup).toBeUndefined();
  expect(startAtOf(playCalls()[0]!)).toBe(600);
});

test('a catch-up validation error shows the server message', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News');
  api.mockImplementation(async (path: string) => {
    if (path === '/api/play') throw new ApiClientError(400, 'VALIDATION', "This channel doesn't support catch-up");
    return liveItem();
  });
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toBe("This channel doesn't support catch-up"));
});

test('catch-up restart after Playback stopped keeps the place in the same programme', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  const v = video();
  Object.defineProperty(v, 'readyState', { get: () => HTMLMediaElement.HAVE_METADATA });
  v.currentTime = 630; // 10:30 into the programme
  heartbeats[0]!.onGone();
  flushSync();
  buttonWith('Tap to restart')!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  // The window starts on the minute, 10:00 in, and is seeked the rest of the way.
  expect(bodyOf(playCalls()[1]!)).toMatchObject({ catchup: { startSec: 4200, stopSec: 7200 }, startAtSec: 0 });
});

test('live shows on-now and From start only with archive', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(onNowLine()).toBe('News at Ten 22:00–23:00'));
  expect(buttonWith('From start')).toBeDefined();
  unmount(app);
  document.body.innerHTML = '';

  serve(liveRes, liveItem({ catchupDays: 0 }));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  expect(buttonWith('From start')).toBeUndefined();
  unmount(app);
  document.body.innerHTML = '';

  serve(liveRes, liveItem({ now: null }));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalled());
  await vi.waitFor(() => expect(document.body.textContent).toContain('No guide information'));
  expect(onNowLine()).toBeNull();
  expect(buttonWith('From start')).toBeUndefined();
});

test('a failed item fetch omits the line and does not block playback', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, new Error('offline'));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(onNowLine()).toBeNull();
  expect(document.body.textContent).not.toContain('No guide information');
});

test('From start navigates to the catch-up URL', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, { ...liveItem(), now: { title: 'News & Co', startSec: 79200, stopSec: 82800 } });
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(buttonWith('From start')).toBeDefined());
  buttonWith('From start')!.click();
  expect(nav.goto).toHaveBeenCalledWith('/watch?item=7&from=79200&to=82800&title=News%20%26%20Co');
});

test('a query change while mounted starts a new session and tears down the old one', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  const destroy = vi.fn();
  attachStream.mockImplementationOnce(() => ({ destroy, showSubtitles: () => {} }));
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  serve(catchupRes, liveItem());
  route.url = new URL('http://localhost/watch?item=7&from=79200&to=82800&title=News');
  tick.n++;
  flushSync();
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(bodyOf(playCalls()[1]!)).toMatchObject({ catchup: { startSec: 79200, stopSec: 82800 } });
  expect(me.positions).toHaveBeenCalledTimes(1); // the first, normal session only
  expect(document.body.textContent).toContain('↺ Catch-up · News');
});

const itemCalls = () => api.mock.calls.filter(([path]) => path === '/api/items/7');
function go(url: string) {
  route.url = new URL(url);
  tick.n++;
  flushSync();
}

const film = { title: 'Film', startSec: 82800, stopSec: 90000 }; // 23:00–01:00, after News at Ten

test('catch-up back to live plays live without catchup; the on-now line needs no refetch while current, and moves on once it has ended', async () => {
  fakeTimeouts();
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(itemCalls()).toHaveLength(1));
  serve(liveRes, liveItem());
  go('http://localhost/watch?item=7');
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  expect(bodyOf(playCalls()[1]!).catchup).toBeUndefined();
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  expect(itemCalls()).toHaveLength(1);

  // From start of News at Ten, watched past its end: back to live shows what is on now.
  serve(catchupRes, liveItem({ now: film }));
  go('http://localhost/watch?item=7&from=79200&to=82800&title=News%20at%20Ten');
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(3));
  await vi.advanceTimersByTimeAsync(82_800_000 - Date.now());
  expect(itemCalls()).toHaveLength(2);
  serve(liveRes, liveItem({ now: film }));
  go('http://localhost/watch?item=7');
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(onNowLine()).toBe('Film 23:00–01:00'));
  expect(itemCalls()).toHaveLength(2);
});

test('From start after the programme has ended opens the programme on now, and does nothing when none is on', async () => {
  fakeTimeouts();
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(buttonWith('From start')).toBeDefined());
  // The clock passes the stop time before the timer has run, as on a phone that has just woken up.
  vi.setSystemTime(83_000_000);
  serve(liveRes, liveItem({ now: film }));
  buttonWith('From start')!.click();
  await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/watch?item=7&from=82800&to=90000&title=Film'));
  expect(nav.goto).toHaveBeenCalledTimes(1);
  expect(itemCalls()).toHaveLength(2);

  await vi.waitFor(() => expect(onNowLine()).toContain('Film'));
  vi.setSystemTime(90_001_000);
  serve(liveRes, liveItem({ now: null }));
  buttonWith('From start')!.click();
  await vi.waitFor(() => expect(itemCalls()).toHaveLength(3));
  await vi.waitFor(() => expect(onNowLine()).toBeNull());
  expect(nav.goto).toHaveBeenCalledTimes(1);
});

test('the refetch timer is cleared on item change and on teardown', async () => {
  fakeTimeouts();
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  expect(vi.getTimerCount()).toBe(1);
  let answer8!: (it: CatalogItem) => void;
  api.mockImplementation((path: string) =>
    path === '/api/play' ? Promise.resolve(liveRes) : path === '/api/items/8' ? new Promise((r) => (answer8 = r)) : Promise.resolve(liveItem()),
  );
  go('http://localhost/watch?item=8');
  await vi.waitFor(() => expect(api.mock.calls.some(([path]) => path === '/api/items/8')).toBe(true));
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(83_000_000 - Date.now()); // past News at Ten's stop, with item 8 still loading
  expect(itemCalls()).toHaveLength(1);
  answer8(liveItem({ id: 8, now: { title: 'Late Show', startSec: 79200, stopSec: 86400 } }));
  await vi.waitFor(() => expect(onNowLine()).toContain('Late Show'));
  expect(vi.getTimerCount()).toBe(1);
  unmount(app);
  app = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

test('two quick query changes leave one active session on the latest window; superseded ones are released once, never attached', async () => {
  route.url = new URL('http://localhost/watch?item=7&t=5');
  const resolvers: ((r: PlayResponse) => void)[] = [];
  api.mockImplementation((path: string) =>
    path === '/api/play' ? new Promise<PlayResponse>((resolve) => resolvers.push(resolve)) : Promise.resolve(liveItem()),
  );
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(playCalls()).toHaveLength(1));
  go('http://localhost/watch?item=7&from=1000&to=2000&title=A');
  go('http://localhost/watch?item=7&from=3000&to=4000&title=B');
  expect(playCalls()).toHaveLength(3);
  resolvers.forEach((resolve, i) => resolve({ ...catchupRes, sessionId: `s${i + 1}`, url: `/api/sessions/s${i + 1}/cid/index.m3u8` }));
  await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(2));
  expect(released.mock.calls.map(([s]) => s).sort()).toEqual(['s1', 's2']);
  expect(attachStream).toHaveBeenCalledTimes(1);
  expect(attachStream.mock.calls[0]![1]).toBe('/api/sessions/s3/cid/index.m3u8');
  expect(bodyOf(playCalls()[2]!)).toMatchObject({ catchup: { startSec: 3000, stopSec: 4000 } });
  expect(document.body.textContent).toContain('↺ Catch-up · B');
});

test('beforeNavigate keeps the session for a same-route navigation and tears it down for any other', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  nav.before!({ to: { url: new URL('http://x/watch?item=7&from=1000&to=2000&title=A') } });
  expect(released).not.toHaveBeenCalled();
  nav.before!({ to: { url: new URL('http://x/browse/live') } });
  expect(released.mock.calls).toEqual([['l1', 'cid']]);
});

const catchupLine = () => document.querySelector('.catchup')!.textContent!.replace(/\s+/g, ' ').trim();

test('a whitespace-only catch-up title has no double separator', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=%20');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(catchupLine()).toBe('↺ Catch-up · 01:00–02:00');
});

test.each([
  ['from=0&to=7200', 'zero from'],
  ['from=abc&to=7200', 'non-numeric from'],
  ['from=3600', 'missing to'],
  ['from=123456789012345678901234567890&to=999999999999999999999999999999', '30-digit values'],
])('%s (%s) falls back to live play', async (query) => {
  route.url = new URL(`http://localhost/watch?item=7&t=5&${query}`);
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(bodyOf(playCalls()[0]!).catchup).toBeUndefined();
  expect(document.body.textContent).not.toContain('Catch-up');
});

test('a catch-up label without a title has no double separator', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(catchupLine()).toBe('↺ Catch-up · 01:00–02:00');
});
