import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, PlayResponse } from '@tv/shared';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/watch?item=7&t=600') }));
const api = vi.hoisted(() => vi.fn());
const attachStream = vi.hoisted(() => vi.fn((_v: HTMLVideoElement, _url: string, _opts: object) => ({ destroy: () => {} })));
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
const me = vi.hoisted(() => ({ positions: vi.fn(async () => []), reportPosition: vi.fn(async () => {}) }));
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
  route.url = new URL('http://localhost/watch?item=7&t=600');
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'visibilityState');
});

/** Fakes the page's timeouts too, from NOW_MS. */
function fakeTimeouts() {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW_MS);
}

const playCalls = () => api.mock.calls.filter(([path]) => path === '/api/play');
const startAtOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string).startAtSec as number;

/** Resumes at 0:10:00, watches until currentTime says `currentTime`, loses the session, then taps restart. */
async function resumeThenRestart(response: PlayResponse, currentTime: number) {
  api.mockImplementation(async (path: string) => (path === '/api/play' ? response : undefined));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'readyState', { get: () => HTMLMediaElement.HAVE_METADATA }); // jsdom never opens media
  video.currentTime = currentTime;
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
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const liveItem = (over: Partial<CatalogItem> = {}) =>
  ({ id: 7, kind: 'live', catchupDays: 3, now: { title: 'News at Ten', startSec: 79200, stopSec: 82800 }, ...over }) as CatalogItem;
const buttonWith = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));

function serve(play: PlayResponse, item: CatalogItem | Error) {
  api.mockImplementation(async (path: string) => {
    if (path === '/api/play') return play;
    if (item instanceof Error) throw item;
    return item;
  });
}

test('catch-up params play catch-up without resume or progress', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(bodyOf(playCalls()[0]!)).toMatchObject({ itemId: 7, catchup: { startSec: 3600, stopSec: 7200 }, startAtSec: 0 });
  expect(me.positions).not.toHaveBeenCalled();
  const video = document.querySelector('video')!;
  video.currentTime = 30;
  video.dispatchEvent(new Event('pause'));
  video.dispatchEvent(new Event('timeupdate'));
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
  expect(document.body.textContent).not.toContain('On now');
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

test('catch-up restart after Playback stopped replays the same window', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=News');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  heartbeats[0]!.onGone();
  flushSync();
  buttonWith('Tap to restart')!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
  expect(bodyOf(playCalls()[1]!)).toMatchObject({ catchup: { startSec: 3600, stopSec: 7200 }, startAtSec: 0 });
});

test('live shows on-now and From start only with archive', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('On now: News at Ten · until 23:00'));
  expect(buttonWith('From start')).toBeDefined();
  unmount(app);
  document.body.innerHTML = '';

  serve(liveRes, liveItem({ catchupDays: 0 }));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('On now: News at Ten'));
  expect(buttonWith('From start')).toBeUndefined();
  unmount(app);
  document.body.innerHTML = '';

  serve(liveRes, liveItem({ now: null }));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalled());
  expect(document.body.textContent).not.toContain('On now');
  expect(buttonWith('From start')).toBeUndefined();
});

test('a failed item fetch omits the line and does not block playback', async () => {
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, new Error('offline'));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(document.body.textContent).not.toContain('On now');
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
  attachStream.mockImplementationOnce(() => ({ destroy }));
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
  await vi.waitFor(() => expect(document.body.textContent).toContain('On now: News at Ten'));
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
  await vi.waitFor(() => expect(document.body.textContent).toContain('On now: Film · until 01:00'));
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

  await vi.waitFor(() => expect(document.body.textContent).toContain('On now: Film'));
  vi.setSystemTime(90_001_000);
  serve(liveRes, liveItem({ now: null }));
  buttonWith('From start')!.click();
  await vi.waitFor(() => expect(itemCalls()).toHaveLength(3));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('On now'));
  expect(nav.goto).toHaveBeenCalledTimes(1);
});

test('the refetch timer is cleared on item change and on teardown', async () => {
  fakeTimeouts();
  route.url = new URL('http://localhost/watch?item=7');
  serve(liveRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('On now: News at Ten'));
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
  await vi.waitFor(() => expect(document.body.textContent).toContain('On now: Late Show'));
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

test('a whitespace-only catch-up title has no double separator', async () => {
  route.url = new URL('http://localhost/watch?item=7&from=3600&to=7200&title=%20');
  serve(catchupRes, liveItem());
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  expect(document.querySelector('.onnow')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('↺ Catch-up · 01:00–02:00');
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
  const text = document.querySelector('.onnow')!.textContent!.replace(/\s+/g, ' ').trim();
  expect(text).toBe('↺ Catch-up · 01:00–02:00');
});
