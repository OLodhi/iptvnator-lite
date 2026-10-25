import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type {
  CatalogItem,
  EpisodeDetail,
  GridRow,
  ItemDetails,
  PlayResponse,
  Programme,
  SavedPosition,
  SessionTracks,
  WatchContext,
} from '@tv/shared';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/watch?item=7&t=600') }));
const api = vi.hoisted(() => vi.fn());
/** The channel list, its order, the next programme and the category, answered apart from each test's play and item answers. */
const side = vi.hoisted(() => vi.fn());
const attachStream = vi.hoisted(() => vi.fn((_v: HTMLVideoElement, _url: string, _opts: object) => ({ destroy: () => {}, showSubtitles: () => {} })));
const heartbeats = vi.hoisted(() => [] as { sessionId: string; onGone: () => void; stopped: boolean }[]);
type BeforeNav = (nav: { to: { url: URL } | null }) => void;
type AfterNav = (nav: { from: { url: URL | null } | null; to: { url: URL } | null }) => void;
const nav = vi.hoisted(() => ({
  goto: vi.fn(async (_u: string, _opts?: object) => {}),
  before: undefined as BeforeNav | undefined,
  after: undefined as AfterNav | undefined,
}));
const tick = $state({ n: 0 }); // bumped to make the mocked page.url reactive, as the real one is
vi.mock('$app/state', () => ({
  page: {
    get url() {
      void tick.n;
      return route.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({
  goto: nav.goto,
  beforeNavigate: (cb: BeforeNav) => (nav.before = cb),
  afterNavigate: (cb: AfterNav) => (nav.after = cb),
}));
vi.mock('hls.js', () => ({ default: {} }));
vi.mock('$lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api')>()),
  api: (path: string, init?: RequestInit) => (/^\/api\/(guide\/|items\/\d+\/context)/.test(path) ? side(path, init) : api(path, init)),
}));
const me = vi.hoisted(() => ({
  positions: vi.fn(async (_id: number): Promise<SavedPosition[]> => []),
  reportPosition: vi.fn(async () => {}),
  favourite: vi.fn(async (_id: number) => {}),
  unfavourite: vi.fn(async (_id: number) => {}),
  itemDetails: vi.fn(async (_id: number): Promise<ItemDetails> => {
    throw new Error('no details'); // the provider has none, unless a test says otherwise
  }),
}));
vi.mock('$lib/me', () => me);
const released = vi.hoisted(() => vi.fn(async (_s: string, _c: string) => {}));
vi.mock('$lib/session', () => ({
  releaseSession: released,
  startHeartbeat: vi.fn((sessionId: string, _c: string, opts: { onGone: () => void }) => {
    const beat = { sessionId, onGone: opts.onGone, stopped: false };
    heartbeats.push(beat);
    return () => {
      beat.stopped = true;
    };
  }),
}));
vi.mock('$lib/clientId', () => ({ getClientId: () => 'cid' }));
vi.mock('$lib/player/attach', () => ({ attachStream }));
const sys = vi.hoisted(() => ({ pip: false, airplay: false, setNowPlaying: vi.fn() }));
vi.mock('$lib/player/system', () => ({
  canPip: () => sys.pip,
  canAirPlay: () => sys.airplay,
  togglePip: async () => {},
  showAirPlay: () => {},
  setNowPlaying: sys.setNowPlaying,
}));

import { ApiClientError } from '$lib/api';
import Watch from './+page.svelte';
import pageSource from './+page.svelte?raw';

/** The declarations of a rule in the page's own styles, which jsdom doesn't apply. */
function pageRule(selector: string): string {
  const css = pageSource.slice(pageSource.indexOf('<style>'));
  const at = css.indexOf(`\n  ${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
}

let app: ReturnType<typeof mount> | undefined;
// 22:13:20 UTC on 1 January 1970: during liveItem's News at Ten (22:00–23:00).
const NOW_MS = 80_000_000;

/** What the side routes answer: the channels of any guide filter, in order, the guide's programmes, and the item's category. */
const guide = { channels: [] as number[], programmes: [] as Programme[], context: { categoryId: null, label: null } as WatchContext };
const channelRow = (id: number): GridRow => ({
  item: { id, kind: 'live', displayName: `Ch ${id}`, logoUrl: null, catchupDays: 0, favourite: false } as CatalogItem,
  programmes: [],
  hasGuide: false,
});
async function answerSide(path: string) {
  const url = new URL(path, 'http://localhost');
  if (url.pathname === '/api/guide/grid') return { items: guide.channels.map(channelRow), nextCursor: null };
  if (url.pathname === '/api/guide/programmes') return { [url.searchParams.get('items')!]: guide.programmes };
  return guide.context;
}
const sideCalls = (pathname: string) => side.mock.calls.map(([p]) => new URL(p as string, 'http://localhost')).filter((u) => u.pathname === pathname);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  api.mockReset();
  side.mockReset().mockImplementation(answerSide);
  guide.channels = [];
  guide.programmes = [];
  guide.context = { categoryId: null, label: null };
  attachStream.mockClear();
  heartbeats.length = 0;
  nav.goto.mockReset();
  nav.after = undefined;
  released.mockClear();
  me.positions.mockClear();
  me.reportPosition.mockClear();
  me.favourite.mockReset();
  me.unfavourite.mockReset();
  me.itemDetails.mockReset();
  localStorage.clear();
  sys.pip = false;
  sys.airplay = false;
  sys.setNowPlaying.mockClear();
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
const kitchen = (over: Partial<CatalogItem> = {}) =>
  ({ id: 11, kind: 'series', displayName: 'The Kitchen', logoUrl: '/api/logos/11', catchupDays: null, favourite: false, ...over }) as CatalogItem;
const buttonWith = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
function enterFullscreen() {
  (document.querySelector('.controls [aria-label="Fullscreen"]') as HTMLElement).click();
  flushSync();
}
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
  expect(states()!.querySelector('[role="status"]')?.textContent).toContain('Starting BBC One…');
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
  (document.querySelector('.controls [aria-label="Exit fullscreen"]') as HTMLElement).click();
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

const loading = () => document.querySelector('.player .loading');

test('a seek restart shows the loading spinner over the video until the new session plays', async () => {
  route.url = new URL('http://localhost/watch?item=5&t=600');
  serve(movieRes, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  playing(video());
  expect(loading()).toBeNull();

  serve({ ...movieRes, sessionId: 'm2', startAtSec: 610 }, movieItem());
  (document.querySelector('.controls [aria-label="Forward 10 seconds"]') as HTMLElement).click();
  flushSync();
  expect(loading()?.getAttribute('role')).toBe('status');
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  expect(loading()).not.toBeNull(); // attached, but nothing is playing yet
  // Nothing covers the video: the transport stays usable.
  expect(states()).toBeNull();
  expect(document.querySelector('.controls')!.classList.contains('covered')).toBe(false);
  playing(video());
  expect(loading()).toBeNull();
});

test('a track restart shows the loading spinner', async () => {
  await playingMovie(vodRes('m1'));
  api.mockImplementation((path: string) => (path === '/api/play' ? new Promise(() => {}) : Promise.resolve(movieItem())));
  pick('Audio', 'Dutch');
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  expect(loading()).not.toBeNull();
  expect(states()).toBeNull();
});

test('a stall shows the loading spinner until playing, and Back and pause still work under it', async () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  nav.after!({ from: { url: new URL('http://localhost/browse/live/3') }, to: { url: route.url } });
  playing(video());
  video().dispatchEvent(new Event('waiting'));
  flushSync();
  expect(loading()).not.toBeNull();
  expect(document.querySelector('.controls')!.classList.contains('covered')).toBe(false);

  (document.querySelector('.controls [aria-label="Pause"]') as HTMLElement).click();
  expect(vi.mocked(HTMLMediaElement.prototype.pause)).toHaveBeenCalledTimes(1);
  (document.querySelector('.topbar .back') as HTMLElement).click();
  enterFullscreen();
  expect(loading()).not.toBeNull();
  (document.querySelector('.controls [aria-label="Back"]') as HTMLElement).click();
  expect(back).toHaveBeenCalledTimes(2);
  // The spinner never takes a tap.
  expect(pageRule('.loading')).toContain('pointer-events: none;');

  playing(video());
  expect(loading()).toBeNull();
});

/** Two quick taps at `x` on a 900 px wide video. */
function doubleTap(x: number) {
  const surface = document.querySelector('.surface') as HTMLElement;
  surface.getBoundingClientRect = () => ({ left: 0, right: 900, width: 900, top: 0, bottom: 500, height: 500, x: 0, y: 0, toJSON() {} }) as DOMRect;
  surface.dispatchEvent(new MouseEvent('click', { clientX: x, bubbles: true }));
  surface.dispatchEvent(new MouseEvent('click', { clientX: x, bubbles: true }));
  flushSync();
}

/** A movie whose start the server gave up on. */
async function failedMovie() {
  route.url = new URL('http://localhost/watch?item=5&t=600');
  api.mockImplementation(async (path: string) => {
    if (path === '/api/play') throw new ApiClientError(504, 'STREAM_START_TIMEOUT', 'timeout');
    return movieItem();
  });
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toBe("This channel isn't responding right now."));
}

test('a double-tap on a side third during failed sends no /api/play', async () => {
  await failedMovie();
  doubleTap(800);
  doubleTap(50);
  // The transport is hidden while covered; pressed anyway, it does nothing.
  (document.querySelector('.controls [aria-label="Forward 10 seconds"]') as HTMLElement).click();
  (document.querySelector('.controls [aria-label="Play"]') as HTMLElement).click();
  await vi.waitFor(() => expect(document.querySelector('.flash')).toBeNull());
  await Promise.resolve();
  expect(playCalls()).toHaveLength(1);
  expect(mediaPlay()).not.toHaveBeenCalled();
  expect(document.querySelector('[role=alert]')?.textContent).toBe("This channel isn't responding right now.");
  expect(document.querySelector('.controls')!.classList.contains('covered')).toBe(true);
});

test('playing after a failed start clears the failed card', async () => {
  await failedMovie();
  playing(video());
  expect(states()).toBeNull();
  expect(document.querySelector('.controls')!.classList.contains('covered')).toBe(false);
});

test('Back with history calls history.back()', async () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  nav.after!({ from: { url: new URL('http://localhost/browse/live/3') }, to: { url: route.url } });
  expect(document.querySelector('.controls [aria-label="Back"]')).toBeNull(); // upright, the top bar has the one Back
  buttonWith('‹ Back')!.click();
  enterFullscreen();
  (document.querySelector('.controls [aria-label="Back"]') as HTMLElement).click();
  expect(back).toHaveBeenCalledTimes(2);
  expect(nav.goto).not.toHaveBeenCalled();
});

test('Back without history goes to the category guide for live', async () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  nav.after?.({ from: null, to: { url: route.url } }); // opened from outside the app
  buttonWith('‹ Back')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/live/3', { replaceState: true });
  enterFullscreen();
  (document.querySelector('.controls [aria-label="Back"]') as HTMLElement).click();
  expect(nav.goto).toHaveBeenCalledTimes(2);
  expect(back).not.toHaveBeenCalled();
  unmount(app);
  document.body.innerHTML = '';

  // Catch-up from favourites, and live without a category.
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News&cat=favourites');
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  buttonWith('‹ Back')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/live/favourites', { replaceState: true });
  unmount(app);
  document.body.innerHTML = '';

  route.url = new URL('http://localhost/watch?item=7');
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  buttonWith('‹ Back')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/live', { replaceState: true });
});

test('Back without history goes to Movies for a movie and to the series for an episode', async () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  const topBack = () => document.querySelector('.topbar .back') as HTMLElement;
  route.url = new URL('http://localhost/watch?item=5&t=600');
  serve(movieRes, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  topBack().click();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/movie', { replaceState: true });
  unmount(app);
  document.body.innerHTML = '';

  route.url = new URL('http://localhost/watch?item=11&episode=111&t=60');
  serve(movieRes, kitchen());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  topBack().click();
  expect(nav.goto).toHaveBeenLastCalledWith('/series/11', { replaceState: true });
  expect(back).not.toHaveBeenCalled();
});

test('the first load of the app has no in-app history', async () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  route.url = new URL('http://localhost/watch?item=5&t=600');
  serve(movieRes, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  // SvelteKit's start-up navigation in a single-page app comes from a page with no URL.
  expect(() => nav.after!({ from: { url: null }, to: { url: route.url } })).not.toThrow();
  (document.querySelector('.topbar .back') as HTMLElement).click();
  expect(back).not.toHaveBeenCalled();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/movie', { replaceState: true });
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
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Playback stopped. Tap to restart.');
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
  expect(nav.goto).toHaveBeenCalledWith('/watch?item=7&from=79200&to=82800&title=News%20%26%20Co', { replaceState: true });
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
  await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/watch?item=7&from=82800&to=90000&title=Film', { replaceState: true }));
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

// Live and catch-up: the category's channels under the video, channel up and down, the live window and the lock screen.

const nowListHrefs = () => [...document.querySelectorAll('.switch a.entry')].map((a) => a.getAttribute('href'));
const infoText = () => document.querySelector('.info')!.textContent!.replace(/\s+/g, ' ').trim();
const actionTexts = () => [...document.querySelectorAll('.actions .act')].map((b) => b.textContent?.trim());
const gridFilters = () => new Set(sideCalls('/api/guide/grid').map((u) => u.searchParams.get('filter')));
const control = (label: string) => document.querySelector(`.controls [aria-label="${label}"]`) as HTMLElement | null;
const prog = (id: number, title: string, startSec: number, stopSec: number): Programme => ({
  id, title, subtitle: null, description: null, category: null, startSec, stopSec,
});

test('live list uses cat, then context', async () => {
  guide.channels = [5, 7, 9];
  guide.context = { categoryId: 3, label: 'Sports' };
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(nowListHrefs()).toEqual(['/watch?item=5&cat=3', '/watch?item=7&cat=3', '/watch?item=9&cat=3']));
  expect(gridFilters()).toEqual(new Set(['category:3']));
  expect(document.querySelector('.switch .entry.playing .title')?.textContent).toBe('Ch 7');
  // The category's name comes from the server.
  expect(sideCalls('/api/items/7/context').map((u) => u.search)).toEqual(['?category=3']);
  await vi.waitFor(() => expect(infoText()).toContain('Sports · channel 2 of 3'));
  expect(document.querySelector('.lhead')?.textContent).toContain('3 channels');
  buttonWith('Guide')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/live/3');
  unmount(app);
  document.body.innerHTML = '';

  // Opened without a category (from Search, a deep link): the item's first visible live category.
  side.mockClear();
  guide.context = { categoryId: 4, label: 'News' };
  route.url = new URL('http://localhost/watch?item=7');
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(nowListHrefs()).toEqual(['/watch?item=5&cat=4', '/watch?item=7&cat=4', '/watch?item=9&cat=4']));
  expect(sideCalls('/api/items/7/context').map((u) => u.search)).toEqual(['']);
  expect(gridFilters()).toEqual(new Set(['category:4']));
  await vi.waitFor(() => expect(infoText()).toContain('News · channel 2 of 3'));
  buttonWith('Guide')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/live/4');
});

test('▲ ▼ go to the neighbours in category order', async () => {
  guide.channels = [9, 7, 4];
  guide.context = { categoryId: 3, label: 'Sports' };
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(infoText()).toContain('channel 2 of 3'));
  enterFullscreen();
  control('Next channel')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=4&cat=3', { replaceState: true });
  control('Previous channel')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=9&cat=3', { replaceState: true });
  unmount(app);
  document.body.innerHTML = '';

  // The last channel has no next. Opened without a category, up and down keep to the one the list shows.
  nav.goto.mockClear();
  route.url = new URL('http://localhost/watch?item=4');
  serve(liveRes, liveItem({ id: 4 }));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(infoText()).toContain('channel 3 of 3'));
  enterFullscreen();
  control('Next channel')!.click();
  expect(nav.goto).not.toHaveBeenCalled();
  control('Previous channel')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=7&cat=3', { replaceState: true });
});

test('three quick ▲ taps end with one session for the last channel; earlier sessions are released', async () => {
  guide.channels = [6, 7, 8, 9, 10, 11];
  guide.context = { categoryId: 3, label: 'Sports' };
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  nav.goto.mockImplementation(async (url: string) => go(`http://localhost${url}`));
  const session = (id: number): PlayResponse => ({ ...liveRes, sessionId: `s${id}`, url: `/api/sessions/s${id}/cid/index.m3u8` });
  const answers = new Map<number, (r: PlayResponse) => void>();
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (path !== '/api/play') return Promise.resolve(liveItem({ id: Number(path.split('/').pop()) }));
    const { itemId } = JSON.parse(init!.body as string) as { itemId: number };
    if (itemId === 7) return Promise.resolve(session(7));
    return new Promise<PlayResponse>((resolve) => answers.set(itemId, resolve));
  });
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  playing(video());
  await vi.waitFor(() => expect(infoText()).toContain('channel 2 of 6'));
  enterFullscreen();

  // Each tap lands before the channel tapped to has started.
  control('Next channel')!.click();
  control('Next channel')!.click();
  control('Next channel')!.click();
  expect(playCalls().map((c) => bodyOf(c).itemId)).toEqual([7, 8, 9, 10]);
  // The playing channel was let go before the next one was asked for.
  expect(released.mock.calls).toEqual([['s7', 'cid']]);
  expect(released.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[api.mock.calls.indexOf(playCalls()[1]!)]!);

  // The answers land out of order: the superseded sessions are released, and only the last channel plays.
  answers.get(9)!(session(9));
  answers.get(8)!(session(8));
  answers.get(10)!(session(10));
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(3));
  expect(attachStream.mock.calls[1]![1]).toBe('/api/sessions/s10/cid/index.m3u8');
  expect(released.mock.calls.map(([s]) => s).sort()).toEqual(['s7', 's8', 's9']);
  expect(heartbeats.filter((b) => !b.stopped).map((b) => b.sessionId)).toEqual(['s10']);
  expect(route.url.search).toBe('?item=10&cat=3');
  expect(fullscreen()).toBe(true);
});

test('live pill jumps to the window end', async () => {
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  // Live, with ten minutes buffered, watched 3:20 behind the live edge.
  const v = video();
  Object.defineProperty(v, 'duration', { configurable: true, get: () => Infinity });
  Object.defineProperty(v, 'seekable', { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 600 }) });
  v.currentTime = 400;
  playing(v);
  const pill = control('Go to live')!;
  expect(pill.textContent?.trim()).toBe('● −3:20');
  // The bar is the programme, 22:00–23:00, with the buffered ten minutes ending now (22:13:20).
  const slider = document.querySelector('.controls [role="slider"]')!;
  expect([slider.getAttribute('aria-valuemin'), slider.getAttribute('aria-valuemax')]).toEqual(['79200', '82800']);
  expect(slider.getAttribute('aria-valuenow')).toBe('79800');
  pill.click();
  expect(v.currentTime).toBe(600);
});

test('catch-up shows Watch live for an airing programme', async () => {
  guide.channels = [5, 7];
  guide.context = { categoryId: 3, label: 'Sports' };
  // News at Ten from its start, while it is still on: the bar ends at now, 13:20 in.
  route.url = new URL('http://localhost/watch?item=7&from=79200&to=82800&title=News%20at%20Ten&cat=3');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  playing(video());
  expect(document.querySelector('.controls [role="slider"]')!.getAttribute('aria-valuemax')).toBe('800');
  expect(control('Go to live')).toBeNull();
  const pill = document.querySelector('.controls .watch-live') as HTMLElement;
  expect(pill.textContent?.trim()).toBe('● Watch live');
  pill.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=7&cat=3', { replaceState: true });
  expect(actionTexts()).toEqual(['★Favourite', '●Watch live', '▦Guide', '⋯More']);
  // The category's channels below; a row plays live.
  await vi.waitFor(() => expect(nowListHrefs()).toEqual(['/watch?item=5&cat=3', '/watch?item=7&cat=3']));
  unmount(app);
  document.body.innerHTML = '';

  // A programme that has ended: the bar is all of it, and Watch live is an action only.
  nav.goto.mockClear();
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News&cat=3');
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  playing(video());
  expect(document.querySelector('.controls [role="slider"]')!.getAttribute('aria-valuemax')).toBe('3600');
  expect(document.querySelector('.controls .watch-live')).toBeNull();
  buttonWith('Watch live')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=7&cat=3', { replaceState: true });
});

test('media session gets channel, programme and previous/next', async () => {
  guide.channels = [5, 7, 9];
  guide.context = { categoryId: 3, label: 'Sports' };
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(sys.setNowPlaying.mock.lastCall?.[1]).toHaveProperty('nexttrack'));
  const [meta, actions] = sys.setNowPlaying.mock.lastCall! as [object, Record<string, () => void>];
  expect(meta).toEqual({ title: 'BBC One', artist: 'News at Ten', artworkUrl: '/api/logos/7' });
  expect(Object.keys(actions).sort()).toEqual(['nexttrack', 'pause', 'play', 'previoustrack']);
  actions.nexttrack!();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=9&cat=3', { replaceState: true });
  actions.previoustrack!();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=5&cat=3', { replaceState: true });
  playing(video());
  actions.pause!();
  expect(vi.mocked(HTMLMediaElement.prototype.pause)).toHaveBeenCalledTimes(1);
  actions.play!();
  expect(mediaPlay()).toHaveBeenCalledTimes(2); // autoplay, then the lock screen's play
  unmount(app);
  app = undefined;
  expect(sys.setNowPlaying).toHaveBeenLastCalledWith(null, {});
});

test('Next is the first programme after the one on now, and is refetched with the on-now line', async () => {
  fakeTimeouts();
  guide.programmes = [prog(1, 'News at Ten', 79200, 82800), prog(3, 'Late Film', 86400, 90000), prog(2, 'Film', 82800, 86400)];
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('.info .next')?.textContent).toBe('Next · 23:00 Film'));
  const asked = sideCalls('/api/guide/programmes');
  expect(asked).toHaveLength(1);
  expect(Object.fromEntries(asked[0]!.searchParams)).toEqual({ items: '7', from: '80000', to: String(80000 + 6 * 3600) });
  enterFullscreen();
  expect(document.querySelector('.controls .next')?.textContent).toBe('Next · 23:00 Film');

  // News at Ten ends: the on-now line moves on to Film, and Next to what follows it.
  serve(liveRes, liveItem({ now: { title: 'Film', startSec: 82800, stopSec: 86400 } }));
  await vi.advanceTimersByTimeAsync(82_800_000 - Date.now());
  await vi.waitFor(() => expect(document.querySelector('.controls .next')?.textContent).toBe('Next · 00:00 Late Film'));
  expect(sideCalls('/api/guide/programmes')).toHaveLength(2);
});

test('★ Favourite toggles the channel, and goes back if the server refuses', async () => {
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  const fav = () => buttonWith('Favourite')!;
  expect(fav().getAttribute('aria-pressed')).toBe('false');
  fav().click();
  flushSync();
  expect(me.favourite).toHaveBeenCalledWith(7);
  expect(fav().getAttribute('aria-pressed')).toBe('true');
  me.unfavourite.mockRejectedValueOnce(new Error('offline'));
  fav().click();
  flushSync();
  expect(me.unfavourite).toHaveBeenCalledWith(7);
  expect(fav().getAttribute('aria-pressed')).toBe('false');
  await vi.waitFor(() => expect(fav().getAttribute('aria-pressed')).toBe('true'));
});

test('turning the phone takes over from ⤢, which is not offered sideways', async () => {
  const screen = fakeScreen();
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  enterFullscreen();
  expect(fullscreen()).toBe(true);
  screen.rotate(true);
  expect(fullscreen()).toBe(true);
  expect(document.querySelector('.controls [aria-label$="ullscreen"]')).toBeNull();
  screen.rotate(false);
  expect(fullscreen()).toBe(false); // upright again is the upright page, not the earlier ⤢
  expect(control('Fullscreen')).not.toBeNull();
  expect(playCalls()).toHaveLength(1);
});

test('the More sheet closes when turning the phone leaves nothing in it', async () => {
  fakeTimeouts();
  const screen = fakeScreen();
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  playing(video());
  await vi.waitFor(() => expect(buttonWith('From start')).toBeDefined());
  buttonWith('More')!.click();
  flushSync();
  const sheet = () => document.querySelector('[role="dialog"][aria-label="More"]');
  expect(sheet()?.textContent).toContain('Full screen'); // Favourite, From start and Guide fill the row
  screen.rotate(true);
  expect(sheet()).toBeNull();
  expect(buttonWith('More')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(3000);
  expect(controlsHidden()).toBe(true); // nothing holds the controls up any more
});

// Back after switching channel: switches on the page replace its history entry, so Back still returns where you came from.

/**
 * The browser history as the page sees it: goto pushes or replaces an entry and, for /watch, navigates the page and
 * runs afterNavigate as SvelteKit does; history.back pops. Returns the entries.
 */
function fakeHistory(...entries: string[]) {
  const stack = [...entries];
  nav.goto.mockImplementation(async (url: string, opts?: { replaceState?: boolean }) => {
    if (opts?.replaceState) stack[stack.length - 1] = url;
    else stack.push(url);
    if (!url.startsWith('/watch')) return;
    const from = route.url;
    go(`http://localhost${url}`);
    nav.after?.({ from: { url: from }, to: { url: route.url } });
  });
  vi.spyOn(history, 'back').mockImplementation(() => void stack.pop());
  return stack;
}

/** Live on channel 7 of Sports (3), whose channels are 7, 8 and 9. */
async function liveOnSeven(from: string | null) {
  guide.channels = [7, 8, 9];
  guide.context = { categoryId: 3, label: 'Sports' };
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  api.mockImplementation(async (path: string) => (path === '/api/play' ? liveRes : liveItem({ id: Number(path.split('/').pop()) })));
  app = mount(Watch, { target: document.body });
  nav.after!({ from: from ? { url: new URL(`http://localhost${from}`) } : null, to: { url: route.url } });
  await vi.waitFor(() => expect(infoText()).toContain('channel 1 of 3'));
  enterFullscreen();
}

test('two ▲ then Back calls history.back() once (to the guide)', async () => {
  const stack = fakeHistory('/browse/live/3', '/watch?item=7&cat=3');
  await liveOnSeven('/browse/live/3');
  control('Next channel')!.click();
  control('Next channel')!.click();
  expect(route.url.search).toBe('?item=9&cat=3');
  expect(stack).toEqual(['/browse/live/3', '/watch?item=9&cat=3']);
  control('Back')!.click();
  expect(history.back).toHaveBeenCalledTimes(1);
  expect(stack).toEqual(['/browse/live/3']);
});

test('a deep link, then ▲, then Back goes to the category guide with replaceState', async () => {
  const stack = fakeHistory('/watch?item=7&cat=3');
  await liveOnSeven(null);
  control('Next channel')!.click();
  expect(stack).toEqual(['/watch?item=8&cat=3']);
  control('Back')!.click();
  expect(history.back).not.toHaveBeenCalled();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/live/3', { replaceState: true });
});

test('channel switches call goto with replaceState: true', async () => {
  guide.channels = [5, 7, 9];
  guide.context = { categoryId: 3, label: 'Sports' };
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(sys.setNowPlaying.mock.lastCall?.[1]).toHaveProperty('nexttrack'));
  await vi.waitFor(() => expect(buttonWith('From start')).toBeDefined());
  enterFullscreen();
  control('Next channel')!.click();
  control('Previous channel')!.click();
  const actions = sys.setNowPlaying.mock.lastCall![1] as Record<string, () => void>;
  actions.nexttrack!();
  actions.previoustrack!();
  buttonWith('From start')!.click();
  const replace = { replaceState: true };
  expect(nav.goto.mock.calls).toEqual([
    ['/watch?item=9&cat=3', replace],
    ['/watch?item=5&cat=3', replace],
    ['/watch?item=9&cat=3', replace],
    ['/watch?item=5&cat=3', replace],
    ['/watch?item=7&from=79200&to=82800&title=News%20at%20Ten&cat=3', replace],
  ]);
  // A tap on the list below replaces too: SvelteKit's link options apply to every link inside.
  expect(document.querySelector('.switch')!.getAttribute('data-sveltekit-replacestate')).toBe('');
  unmount(app);
  document.body.innerHTML = '';

  nav.goto.mockClear();
  route.url = new URL('http://localhost/watch?item=7&from=79200&to=82800&title=News%20at%20Ten&cat=3');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  playing(video());
  (document.querySelector('.controls .watch-live') as HTMLElement).click();
  buttonWith('Watch live')!.click();
  expect(nav.goto.mock.calls).toEqual([['/watch?item=7&cat=3', replace], ['/watch?item=7&cat=3', replace]]);
});

test('Back is labelled with the category name on live', async () => {
  const topBack = () => document.querySelector('.topbar .back')!;
  guide.context = { categoryId: 3, label: 'Sports' };
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(topBack().textContent).toBe('‹ Sports'));
  expect(topBack().getAttribute('aria-label')).toBe('Back to Sports');
  unmount(app);
  document.body.innerHTML = '';

  // Catch-up too, and the favourites.
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News&cat=3');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(topBack().textContent).toBe('‹ Sports'));
  unmount(app);
  document.body.innerHTML = '';

  guide.context = { categoryId: null, label: 'Favourites' };
  route.url = new URL('http://localhost/watch?item=7&cat=favourites');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(topBack().textContent).toBe('‹ Favourites'));
  unmount(app);
  document.body.innerHTML = '';

  // A movie says Movies, and an episode its series.
  route.url = new URL('http://localhost/watch?item=5&t=600');
  serve(movieRes, movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(4));
  expect(topBack().textContent).toBe('‹ Movies');
  expect(topBack().getAttribute('aria-label')).toBe('Back to Movies');
  unmount(app);
  document.body.innerHTML = '';

  route.url = new URL('http://localhost/watch?item=11&episode=112&t=60');
  serve(movieRes, kitchen());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(topBack().textContent).toBe('‹ The Kitchen'));
  unmount(app);
  document.body.innerHTML = '';

  // A channel whose category isn't known keeps the plain label.
  guide.context = { categoryId: null, label: null };
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(onNowLine()).toContain('News at Ten'));
  expect(topBack().textContent).toBe('‹ Back');
});

// Movies and episodes: details, audio and subtitle tracks, the season's episodes and Up next.

const track = (index: number, label: string, language: string | null, available = true) => ({
  index, label, language, isDefault: false, forced: false, available,
});
const tracksOf = (over: Partial<SessionTracks> = {}): SessionTracks => ({
  audio: [track(1, 'English', 'en'), track(2, 'Dutch', 'nl')],
  subtitles: [track(3, 'English', 'en'), track(4, 'Dutch', 'nl'), track(5, 'Dutch (PGS)', 'nl', false)],
  audioIndex: 1,
  subtitleIndex: null,
  ...over,
});
/** A movie or episode HLS session that started at 10:00, with tracks. */
const vodRes = (sessionId: string, over: Partial<PlayResponse> = {}): PlayResponse => ({
  sessionId, mode: 'hls', url: `/api/sessions/${sessionId}/cid/master.m3u8`, durationSec: 3000, startAtSec: 600, tracks: tracksOf(), ...over,
});
const episode = (remoteId: string, episodeNum: number, title: string): EpisodeDetail => ({
  remoteId, title, episodeNum, durationSec: 1980, imageUrl: `/api/art/11/episode-${remoteId}`, airDate: null, quality: 'HD',
});
const details = {
  plot: null, genre: null, cast: null, director: null, year: null, rating: null, posterUrl: null, backdropUrl: null,
};
const heatDetails: ItemDetails = {
  ...details, kind: 'movie', durationSec: 6000, plot: 'A thief plans one last job.', genre: 'Crime, Thriller', year: 1995, rating: '8.3',
  posterUrl: '/api/art/5/poster',
};
const kitchenDetails: ItemDetails = {
  ...details, kind: 'series', plot: 'A chef comes home.', posterUrl: '/api/art/11/poster',
  seasons: [
    { season: 1, name: 'Season 1', coverUrl: null, episodes: [episode('111', 1, 'Pilot'), episode('112', 2, 'Next')] },
    { season: 2, name: 'Season 2', coverUrl: null, episodes: [episode('121', 1, 'Doors')] },
  ],
};
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const sheet = (title: string) => document.querySelector(`[role="dialog"][aria-label="${title}"]`);
/** Opens the Subtitles or Audio sheet from the actions under the video, and picks `label`. */
function pick(kind: 'Subtitles' | 'Audio', label: string) {
  [...document.querySelectorAll<HTMLButtonElement>('.actions .act')].find((b) => b.textContent?.includes(kind))!.click();
  flushSync();
  [...sheet(kind)!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.replace('✓', '').trim() === label)!.click();
  flushSync();
}
/** Mounts the movie at 10:00 and plays it 30 s in. */
async function playingMovie(play: PlayResponse | ((body: { subtitleIndex?: number | null }) => Promise<PlayResponse>)) {
  route.url = new URL('http://localhost/watch?item=5&t=600');
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (path !== '/api/play') return Promise.resolve(movieItem());
    return typeof play === 'function' ? play(JSON.parse(init!.body as string)) : Promise.resolve(play);
  });
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  const v = video();
  Object.defineProperty(v, 'readyState', { get: () => HTMLMediaElement.HAVE_METADATA });
  v.currentTime = 30;
  playing(v);
  return v;
}
const chips = () => [...document.querySelectorAll('.controls .chip')].map((c) => text(c));

test('movie info shows plot and genre', async () => {
  sys.pip = true;
  sys.airplay = true;
  me.itemDetails.mockResolvedValue(heatDetails);
  route.url = new URL('http://localhost/watch?item=5&t=600');
  serve(vodRes('m1'), movieItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(text(document.querySelector('.info .plot'))).toBe('A thief plans one last job.'));
  expect(me.itemDetails).toHaveBeenCalledWith(5);
  expect(text(document.querySelector('.info .title'))).toBe('Heat');
  expect(text(document.querySelector('.info .meta'))).toBe('1995 · Crime, Thriller · ★ 8.3');
  // ★, PiP, AirPlay, then More with the tracks; and nothing to switch to under a movie.
  expect(actionTexts()).toEqual(['★Favourite', '⧉Picture in picture', '⎚AirPlay', '⋯More']);
  buttonWith('More')!.click();
  flushSync();
  expect([...sheet('More')!.querySelectorAll('button')].map((b) => text(b))).toEqual(['💬 Subtitles', '♪ Audio', '⤢ Full screen', 'Cancel']);
  expect(document.querySelector('.switch')).toBeNull();
});

test('HLS track pick restarts at the current position with audioIndex', async () => {
  const v = await playingMovie(vodRes('m1'));
  api.mockImplementation((path: string) =>
    Promise.resolve(path === '/api/play' ? vodRes('m2', { startAtSec: 630, tracks: tracksOf({ audioIndex: 2 }) }) : movieItem()),
  );
  pick('Audio', 'Dutch');
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  const body = bodyOf(playCalls()[1]!);
  expect(body).toMatchObject({ itemId: 5, startAtSec: 630, audioIndex: 2 });
  expect(body).not.toHaveProperty('subtitleIndex');
  expect(released.mock.calls).toEqual([['m1', 'cid']]);
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  expect(attachStream.mock.calls[1]![0]).toBe(v);
  expect(states()).toBeNull(); // a brief pause, not a Starting card
  // Picking the track already playing does nothing.
  pick('Audio', 'Dutch');
  expect(playCalls()).toHaveLength(2);
  // Fullscreen, the chips say what is chosen.
  enterFullscreen();
  expect(chips()).toEqual(['💬 Subtitles: Off', '♪ Audio: Dutch']);
});

test('subtitle Off sends null and clears the remembered language', async () => {
  localStorage.setItem('tv.subtitleLang', 'en');
  await playingMovie(vodRes('m1', { tracks: tracksOf({ subtitleIndex: 3 }) }));
  buttonWith('Subtitles')!.click();
  flushSync();
  const options = [...sheet('Subtitles')!.querySelectorAll('button')];
  expect(options.map((b) => [text(b), b.getAttribute('aria-pressed')])).toEqual([
    ['Off', 'false'],
    ['✓English', 'true'],
    ['Dutch', 'false'],
    ['Dutch (PGS) (not supported on this device)', 'false'],
    ['Cancel', null],
  ]);
  options[0]!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  expect(bodyOf(playCalls()[1]!)).toMatchObject({ startAtSec: 630, subtitleIndex: null });
  expect(localStorage.getItem('tv.subtitleLang')).toBeNull();
  unmount(app!);
  document.body.innerHTML = '';

  // A title with no subtitles in the remembered language starts with them off: Off still forgets it, with no restart.
  localStorage.setItem('tv.subtitleLang', 'fr');
  attachStream.mockClear();
  await playingMovie(vodRes('m3'));
  pick('Subtitles', 'Off');
  expect(localStorage.getItem('tv.subtitleLang')).toBeNull();
  expect(playCalls()).toHaveLength(3);
});

test('a start with a subtitle shows it', async () => {
  const showSubtitles = vi.fn();
  attachStream.mockImplementationOnce(() => ({ destroy: () => {}, showSubtitles }));
  await playingMovie(vodRes('m1', { tracks: tracksOf({ subtitleIndex: 4 }) }));
  expect(showSubtitles).toHaveBeenCalledWith(true);
  enterFullscreen();
  expect(chips()).toEqual(['💬 Subtitles: Dutch', '♪ Audio: English']);

  // A start without one leaves the stream's subtitles alone.
  const quiet = vi.fn();
  attachStream.mockImplementationOnce(() => ({ destroy: () => {}, showSubtitles: quiet }));
  api.mockImplementation((path: string) => Promise.resolve(path === '/api/play' ? vodRes('m2') : movieItem()));
  (document.querySelector('.controls .chip') as HTMLElement).click();
  flushSync();
  [...sheet('Subtitles')!.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === 'Off')!.click();
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  expect(quiet).not.toHaveBeenCalled();
});

test('two quick subtitle changes end with one session for the last choice', async () => {
  const session = (id: string): PlayResponse => vodRes(id, { startAtSec: 630 });
  const answers = new Map<number, (r: PlayResponse) => void>();
  await playingMovie((body) =>
    body.subtitleIndex === undefined ? Promise.resolve(vodRes('s1')) : new Promise((resolve) => answers.set(body.subtitleIndex!, resolve)),
  );

  // The second choice lands before the first restart has started.
  pick('Subtitles', 'English');
  pick('Subtitles', 'Dutch');
  expect(playCalls().map((c) => bodyOf(c).subtitleIndex)).toEqual([undefined, 3, 4]);
  expect(playCalls().slice(1).map(startAtOf)).toEqual([630, 630]); // both from where it was
  // The playing session was let go before the first restart was asked for.
  expect(released.mock.calls).toEqual([['s1', 'cid']]);
  expect(released.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[api.mock.calls.indexOf(playCalls()[1]!)]!);

  // The answers land out of order: the superseded session is released, and only the last choice plays.
  answers.get(4)!(session('s3'));
  answers.get(3)!(session('s2'));
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(2));
  expect(attachStream.mock.calls[1]![1]).toBe('/api/sessions/s3/cid/master.m3u8');
  expect(released.mock.calls.map(([s]) => s).sort()).toEqual(['s1', 's2']);
  expect(heartbeats.filter((b) => !b.stopped).map((b) => b.sessionId)).toEqual(['s3']);
  expect(localStorage.getItem('tv.subtitleLang')).toBe('nl');
});

test('starts send the remembered subtitle language', async () => {
  localStorage.setItem('tv.subtitleLang', 'nl');
  await playingMovie(vodRes('m1'));
  expect(bodyOf(playCalls()[0]!)).toMatchObject({ itemId: 5, subtitleLanguage: 'nl' });
  // A seek restart asks again, so the new session has the subtitles too.
  api.mockImplementation((path: string) => (path === '/api/play' ? new Promise(() => {}) : Promise.resolve(movieItem())));
  (document.querySelector('.controls [aria-label="Forward 10 seconds"]') as HTMLElement).click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  expect(bodyOf(playCalls()[1]!)).toMatchObject({ startAtSec: 640, subtitleLanguage: 'nl' });
  unmount(app!);
  document.body.innerHTML = '';

  // A language /api/play would refuse is not sent, and a track without a usable one isn't remembered.
  localStorage.setItem('tv.subtitleLang', 'pt-br');
  attachStream.mockClear();
  const tracks = tracksOf({ subtitles: [track(6, 'Portuguese (Brazil)', 'pt-br')] });
  await playingMovie(vodRes('m3', { tracks }));
  expect(bodyOf(playCalls()[2]!).subtitleLanguage).toBeNull();
  localStorage.setItem('tv.subtitleLang', 'en');
  api.mockImplementation((path: string) => Promise.resolve(path === '/api/play' ? vodRes('m4', { tracks }) : movieItem()));
  pick('Subtitles', 'Portuguese (Brazil)');
  await vi.waitFor(() => expect(playCalls()).toHaveLength(4));
  expect(bodyOf(playCalls()[3]!).subtitleIndex).toBe(6);
  expect(localStorage.getItem('tv.subtitleLang')).toBe('en');
  unmount(app!);
  document.body.innerHTML = '';

  // Live has no tracks to ask for.
  route.url = new URL('http://localhost/watch?item=7&cat=3');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(playCalls()).toHaveLength(5));
  expect(bodyOf(playCalls()[4]!)).not.toHaveProperty('subtitleLanguage');
});

/** The element's own audio and text tracks, as Safari lists them for a direct file. */
function nativeTracks(v: HTMLVideoElement) {
  const audio = [
    { label: '', language: 'nld', enabled: true },
    { label: 'Commentary', language: 'en-GB', enabled: false },
  ];
  const text = [
    { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled' },
    { kind: 'metadata', label: '', language: 'nl', mode: 'hidden' },
    { kind: 'captions', label: '', language: 'nl', mode: 'disabled' },
  ];
  Object.defineProperty(v, 'audioTracks', { configurable: true, get: () => audio });
  Object.defineProperty(v, 'textTracks', { configurable: true, get: () => text });
  return { audio, text };
}

test('direct mode enables an English audio track on metadata', async () => {
  localStorage.setItem('tv.subtitleLang', 'nl');
  const direct: PlayResponse = { sessionId: 'd1', mode: 'direct', url: '/api/sessions/d1/cid/direct', durationSec: 3000, startAtSec: 600, tracks: null };
  const v = await playingMovie(direct);
  const { audio, text: subs } = nativeTracks(v);
  v.dispatchEvent(new Event('loadedmetadata'));
  flushSync();
  expect(audio.map((t) => t.enabled)).toEqual([false, true]);
  expect(subs.map((t) => t.mode)).toEqual(['disabled', 'hidden', 'showing']); // the remembered Dutch
  enterFullscreen();
  expect(chips()).toEqual(['💬 Subtitles: Dutch', '♪ Audio: English (Commentary)']);
  (document.querySelector('.controls [aria-label="Exit fullscreen"]') as HTMLElement).click();
  flushSync();

  // The sheets switch the element's own tracks: no new session.
  pick('Audio', 'Dutch');
  expect(audio.map((t) => t.enabled)).toEqual([true, false]);
  pick('Subtitles', 'English');
  expect(subs.map((t) => t.mode)).toEqual(['showing', 'hidden', 'disabled']);
  expect(localStorage.getItem('tv.subtitleLang')).toBe('en');
  pick('Subtitles', 'Off');
  expect(subs.map((t) => t.mode)).toEqual(['disabled', 'hidden', 'disabled']);
  expect(localStorage.getItem('tv.subtitleLang')).toBeNull();
  expect(playCalls()).toHaveLength(1);
  expect(bodyOf(playCalls()[0]!)).not.toHaveProperty('audioIndex');

  // English already on is left as it is.
  audio[0]!.enabled = false;
  audio[1]!.enabled = true;
  audio[1]!.language = 'eng';
  v.dispatchEvent(new Event('loadedmetadata'));
  expect(audio.map((t) => t.enabled)).toEqual([false, true]);
});

/** The Kitchen's second episode, from the series page (no time given). */
async function watchingNext(saved: SavedPosition[] = []) {
  me.itemDetails.mockResolvedValue(kitchenDetails);
  me.positions.mockResolvedValueOnce(saved);
  route.url = new URL('http://localhost/watch?item=11&episode=112');
  serve(vodRes('e1', { startAtSec: 0, durationSec: 1980 }), kitchen());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(document.querySelectorAll('.switch .ep-row')).toHaveLength(2));
  playing(video());
}

test('episode list highlights the playing episode', async () => {
  const pilotWatched: SavedPosition = { episodeRemoteId: '111', positionSec: 0, durationSec: null, finished: true, manual: true, updatedAt: 1 };
  await watchingNext([pilotWatched]);
  expect(bodyOf(playCalls()[0]!)).toMatchObject({ itemId: 11, episodeRemoteId: '112', startAtSec: 0 });
  const rows = [...document.querySelectorAll('.switch .ep-row')];
  expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/watch?item=11&episode=111', '/watch?item=11&episode=112']);
  expect(rows.map((r) => r.classList.contains('current'))).toEqual([false, true]);
  expect(text(rows[1]!.querySelector('.flag'))).toBe('Playing');
  expect(text(rows[0]!.querySelector('.s'))).toBe('watched HD');
  expect(text(document.querySelector('.switch .lhead'))).toBe('Season 1 2 episodes');
  // A row plays its episode in place of this history entry, as Next episode does.
  expect(document.querySelector('.switch')!.getAttribute('data-sveltekit-replacestate')).toBe('');

  // What it is, what to do, and where Back goes.
  expect(text(document.querySelector('.info .title'))).toBe('The Kitchen');
  expect(text(document.querySelector('.info .meta'))).toBe('Season 1 · Episode 2 · Next · 33 min');
  expect(actionTexts()).toEqual(['★Favourite', '⏭Next episode', '💬Subtitles', '⋯More']);
  expect(text(document.querySelector('.topbar .back'))).toBe('‹ The Kitchen');
  buttonWith('Next episode')!.click();
  expect(nav.goto).toHaveBeenLastCalledWith('/watch?item=11&episode=121', { replaceState: true });
  // ★ is the series.
  buttonWith('Favourite')!.click();
  expect(me.favourite).toHaveBeenCalledWith(11);
});

const pilotAt20: SavedPosition = { episodeRemoteId: '111', positionSec: 1200, durationSec: 1980, finished: false, manual: false, updatedAt: 2 };

test('switching to a part-watched episode releases the playing one before Resume shows', async () => {
  const destroy = vi.fn();
  attachStream.mockImplementationOnce(() => ({ destroy, showSubtitles: () => {} }));
  await watchingNext();
  me.positions.mockResolvedValueOnce([pilotAt20]);
  go('http://localhost/watch?item=11&episode=111');
  await vi.waitFor(() => expect(buttonWith('Resume from 20:00')).toBeDefined());
  // Nothing plays under the prompt, and the provider's one stream is free again.
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(released.mock.calls).toEqual([['e1', 'cid']]);
  expect(heartbeats.map((b) => b.stopped)).toEqual([true]);
  expect(playCalls()).toHaveLength(1);

  buttonWith('Resume from 20:00')!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  expect(bodyOf(playCalls()[1]!)).toMatchObject({ episodeRemoteId: '111', startAtSec: 1200 });
});

test('a session lost under the Resume prompt leaves the prompt as it is', async () => {
  await watchingNext();
  const gone = heartbeats[0]!.onGone;
  me.positions.mockResolvedValueOnce([pilotAt20]);
  go('http://localhost/watch?item=11&episode=111');
  await vi.waitFor(() => expect(buttonWith('Resume from 20:00')).toBeDefined());
  gone();
  flushSync();
  expect(buttonWith('Resume from 20:00')).toBeDefined();
  expect(buttonWith('Tap to restart')).toBeUndefined();
});

test('Up next plays the next episode after 5 s', async () => {
  fakeTimeouts();
  await watchingNext();
  expect(document.querySelector('.up-next')).toBeNull();
  video().dispatchEvent(new Event('ended'));
  flushSync();
  // The last episode of season 1 is followed by the first of season 2.
  expect(text(document.querySelector('.up-next .label'))).toBe('Up next · S2 E1');
  expect(text(document.querySelector('.up-next .title'))).toBe('Doors');
  await vi.advanceTimersByTimeAsync(4999);
  expect(nav.goto).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(nav.goto.mock.calls).toEqual([['/watch?item=11&episode=121', { replaceState: true }]]);
  unmount(app!);
  document.body.innerHTML = '';

  // Cancelled, it stays on the ended episode.
  nav.goto.mockClear();
  await watchingNext();
  video().dispatchEvent(new Event('ended'));
  flushSync();
  buttonWith('Cancel')!.click();
  flushSync();
  expect(document.querySelector('.up-next')).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(nav.goto).not.toHaveBeenCalled();
  unmount(app!);
  document.body.innerHTML = '';

  // The last episode has nothing up next.
  me.itemDetails.mockResolvedValue(kitchenDetails);
  route.url = new URL('http://localhost/watch?item=11&episode=121');
  serve(vodRes('e3', { startAtSec: 0 }), kitchen());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(document.querySelectorAll('.switch .ep-row')).toHaveLength(1));
  video().dispatchEvent(new Event('ended'));
  flushSync();
  expect(document.querySelector('.up-next')).toBeNull();
  expect(buttonWith('Next episode')).toBeUndefined();
});

test('media session for an episode: its title, the series and poster, with ±10 s', async () => {
  await watchingNext();
  await vi.waitFor(() => expect(sys.setNowPlaying.mock.lastCall?.[0]).toMatchObject({ title: 'S1 E2 · Next' }));
  const [meta, actions] = sys.setNowPlaying.mock.lastCall! as [object, Record<string, () => void>];
  expect(meta).toEqual({ title: 'S1 E2 · Next', artist: 'The Kitchen', artworkUrl: '/api/art/11/poster' });
  expect(Object.keys(actions).sort()).toEqual(['pause', 'play', 'seekbackward', 'seekforward']);
  const v = video();
  Object.defineProperty(v, 'readyState', { get: () => HTMLMediaElement.HAVE_METADATA });
  Object.defineProperty(v, 'seekable', { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 1980 }) });
  v.currentTime = 100;
  actions.seekforward!();
  expect(v.currentTime).toBe(110);
  actions.seekbackward!();
  expect(v.currentTime).toBe(100);
  unmount(app!);
  document.body.innerHTML = '';

  // A movie: its name as the title and the artist.
  me.itemDetails.mockResolvedValue(heatDetails);
  await playingMovie(vodRes('m1'));
  await vi.waitFor(() => expect(sys.setNowPlaying.mock.lastCall?.[0]).toEqual({ title: 'Heat', artist: 'Heat', artworkUrl: '/api/art/5/poster' }));
});
