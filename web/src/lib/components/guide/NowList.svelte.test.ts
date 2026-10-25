import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, GridRow, Page, Programme } from '@tv/shared';

const guide = vi.hoisted(() => ({ grid: vi.fn() }));
vi.mock('$lib/guide', () => guide);

import NowList from './NowList.svelte';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const NOW_SEC = NOW / 1000;
const channel = (id: number, name = `Ch ${id}`): CatalogItem => ({
  id, providerId: 1, kind: 'live', name, displayName: name, logoUrl: null, catchupDays: 0, year: null, rating: null, favourite: false,
});
const show = (id: number, title: string, startSec: number, stopSec: number): Programme => ({
  id, title, subtitle: null, description: null, category: null, startSec, stopSec,
});
/** A channel with a guide, on by default from 10 minutes ago to 10 minutes from now. */
const row = (id: number, over: Partial<GridRow> = {}): GridRow => ({
  item: channel(id), programmes: [show(id, `Show ${id}`, NOW_SEC - 600, NOW_SEC + 600)], hasGuide: true, ...over,
});
const page = (...items: GridRow[]): Page<GridRow> => ({ items, nextCursor: null });

const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')!;

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  guide.grid.mockReset().mockResolvedValue(page());
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerHeight', innerHeight);
  Reflect.deleteProperty(document, 'visibilityState');
});

const mountIt = (props: { filter: string; label: string; onLongPress?: (item: CatalogItem) => void; currentItemId?: number }) => {
  app = mount(NowList, { target: document.body, props: { ...props, tz: 'UTC' } });
  flushSync();
};
const texts = (selector: string) => [...document.querySelectorAll(selector)].map((e) => e.textContent?.trim());

test('lists every channel in the filter in order, one row each, with what is on now underneath', async () => {
  // Two versions of one channel, linked to the same guide channel: the same programme, and still two rows.
  const race = show(7, 'F1: Mexico GP', NOW_SEC - 1800, NOW_SEC + 1800);
  guide.grid.mockResolvedValue(page(
    { item: channel(1, 'UK| SKY SPORTS F1 HD'), programmes: [race], hasGuide: true },
    { item: channel(2, 'UK| SKY SPORTS F1 FHD'), programmes: [race], hasGuide: true },
    { item: channel(3, 'UK| BT BOX OFFICE HD'), programmes: [], hasGuide: false },
    // A guide, and a gap: the next programme starts half a minute from now.
    { item: channel(4, 'UK| TNT SPORTS 5 HD'), programmes: [show(8, 'Boxing', NOW_SEC + 30, NOW_SEC + 3600)], hasGuide: true },
  ));
  mountIt({ filter: 'category:4', label: 'UK| Sports' });
  await vi.waitFor(() => expect(document.querySelectorAll('.entry')).toHaveLength(4));
  expect(guide.grid).toHaveBeenCalledTimes(1);
  expect(guide.grid.mock.calls[0]![0]).toMatchObject({ filter: 'category:4', from: NOW_SEC, to: NOW_SEC + 60, cursor: null });
  expect(texts('.entry .title')).toEqual(['UK| SKY SPORTS F1 HD', 'UK| SKY SPORTS F1 FHD', 'UK| BT BOX OFFICE HD', 'UK| TNT SPORTS 5 HD']);
  expect(texts('.entry .sub')).toEqual(['F1: Mexico GP · until 12:30', 'F1: Mexico GP · until 12:30', 'No guide information', 'Nothing on now']);
  const bars = [...document.querySelectorAll('.entry')].map((e) => e.querySelector<HTMLElement>('.bar > span')?.style.width ?? null);
  expect(bars).toEqual(['50%', '50%', null, null]);
});

test('a row moves on when its programme ends, without a request', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  guide.grid.mockResolvedValue(page(
    row(1, { programmes: [show(1, 'News', NOW_SEC - 1800, NOW_SEC + 20), show(2, 'Weather', NOW_SEC + 20, NOW_SEC + 600)] }),
    row(2, { programmes: [show(3, 'Film', NOW_SEC - 3600, NOW_SEC + 20)] }),
  ));
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(texts('.entry .sub')).toEqual(['News · until 12:00', 'Film · until 12:00']));
  await vi.advanceTimersByTimeAsync(30_000); // the shared clock's tick
  flushSync();
  expect(texts('.entry .sub')).toEqual(['Weather · until 12:10', 'Nothing on now']);
  expect(guide.grid).toHaveBeenCalledTimes(1);
});

test('a tap watches the channel live, and a long-press hands the channel over and swallows the tap', async () => {
  const onLongPress = vi.fn();
  guide.grid.mockResolvedValue(page(row(1), row(2, { programmes: [], hasGuide: false })));
  mountIt({ filter: 'category:4', label: 'Sports', onLongPress });
  await vi.waitFor(() => expect(document.querySelectorAll('.entry')).toHaveLength(2));
  // The watch page keeps the category, for its list and channel up and down.
  expect([...document.querySelectorAll('a.entry')].map((a) => a.getAttribute('href'))).toEqual(['/watch?item=1&cat=4', '/watch?item=2&cat=4']);
  expect([...document.querySelectorAll('.entry .play')].map((e) => e.getAttribute('aria-label'))).toEqual(['Watch live', 'Watch live']);
  const unguided = document.querySelectorAll<HTMLElement>('.entry')[1]!;
  unguided.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  await new Promise((r) => setTimeout(r, 560));
  expect(onLongPress).toHaveBeenCalledWith(expect.objectContaining({ id: 2, displayName: 'Ch 2' }));
  unguided.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  unguided.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true); // a long-press does not also open the watch page
});

test('currentItemId highlights Playing', async () => {
  guide.grid.mockResolvedValue(page(row(1), row(2), row(3)));
  mountIt({ filter: 'favourites', label: 'Favourites', currentItemId: 2 });
  await vi.waitFor(() => expect(document.querySelectorAll('.entry')).toHaveLength(3));
  const entries = [...document.querySelectorAll<HTMLElement>('.entry')];
  expect(entries.map((e) => e.classList.contains('playing'))).toEqual([false, true, false]);
  expect(entries.map((e) => e.getAttribute('aria-current'))).toEqual([null, 'true', null]);
  expect(entries[1]!.querySelector('.tag')?.textContent).toBe('Playing');
  expect(entries[1]!.querySelector('.play')).toBeNull();
  expect(texts('.entry .tag')).toEqual(['Playing']);
  expect(entries.map((e) => e.getAttribute('href'))).toEqual(['/watch?item=1&cat=favourites', '/watch?item=2&cat=favourites', '/watch?item=3&cat=favourites']);
});

test('pages on scroll end', async () => {
  guide.grid.mockResolvedValueOnce({ items: [row(1), row(2)], nextCursor: 'c2' });
  guide.grid.mockResolvedValueOnce(page(row(3)));
  mountIt({ filter: 'favourites', label: 'Favourites' });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(2));
  expect(guide.grid.mock.calls[0]![0]).toMatchObject({ filter: 'favourites', cursor: null });
  expect(guide.grid.mock.calls[1]![0]).toMatchObject({ filter: 'favourites', cursor: 'c2' });
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 1', 'Ch 2', 'Ch 3']));
});

test('a new filter starts again from page 1 and ignores the old answer', async () => {
  let resolveOld!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
  const props = $state({ filter: 'category:4', label: 'Sports', tz: 'UTC' });
  app = mount(NowList, { target: document.body, props });
  flushSync();
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(1));
  guide.grid.mockResolvedValueOnce(page(row(2)));
  props.filter = 'category:5';
  props.label = 'News';
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 2']));
  expect(guide.grid.mock.calls[1]![0]).toMatchObject({ filter: 'category:5', cursor: null });
  expect((guide.grid.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  resolveOld(page(row(1)));
  await new Promise((r) => setTimeout(r, 20));
  expect(texts('.entry .title')).toEqual(['Ch 2']);
});

test('an empty list says it has no channels, with the name when there is one', async () => {
  mountIt({ filter: 'category:5', label: 'Sport' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No channels in Sport'));
  unmount(app!);
  mountIt({ filter: 'category:5', label: '' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No channels'));
  expect(document.body.textContent).not.toContain('No channels in');
  unmount(app!);
  mountIt({ filter: 'favourites', label: 'Favourites' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No favourite channels yet'));
});

test('an error shows Retry, which reloads from page 1', async () => {
  guide.grid.mockRejectedValueOnce(new Error('boom'));
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(document.querySelector('.retry')).not.toBeNull());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong. Please try again.');
  guide.grid.mockResolvedValueOnce(page(row(4)));
  document.querySelector<HTMLButtonElement>('.retry')!.click();
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 4']));
  expect(guide.grid.mock.calls[1]![0].cursor).toBeNull();
  expect(document.querySelector('.retry')).toBeNull();
});

/** The minute tick on a fake clock, in a viewport tall enough to page until the data runs out. */
function tallNow() {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100_000 });
}

/** `n` channels whose programme is titled with the current version, paged like the route: 30 by default, at most 100. */
function serveRows(n: number) {
  const state = { version: 1, rowsAtCall: [] as number[] };
  guide.grid.mockImplementation(async (p: { cursor?: string | null; limit?: number }) => {
    state.rowsAtCall.push(document.querySelectorAll('.entry').length);
    const from = p.cursor ? Number(p.cursor) : 0;
    const to = Math.min(n, from + Math.min(p.limit ?? 30, 100));
    const items = Array.from({ length: to - from }, (_, i) =>
      row(from + i + 1, { programmes: [show(from + i + 1, `Show ${from + i + 1} v${state.version}`, NOW_SEC - 600, NOW_SEC + 600)] }),
    );
    return { items, nextCursor: to < n ? String(to) : null };
  });
  return state;
}
const askedFor = () => guide.grid.mock.calls.map(([p]) => [p.cursor, p.limit]);

test('the minute refresh keeps the loaded depth, refreshed, in one swap', async () => {
  tallNow();
  const server = serveRows(60);
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(document.querySelectorAll('.entry')).toHaveLength(60));
  expect(askedFor()).toEqual([[null, undefined], ['30', undefined]]); // two pages
  guide.grid.mockClear();
  server.version = 2;
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 60 v2'));
  expect(askedFor()).toEqual([[null, 60]]);
  expect(guide.grid.mock.calls[0]![0]).toMatchObject({ from: NOW_SEC + 60, to: NOW_SEC + 120 }); // asked about the new now
  expect(document.querySelectorAll('.entry')).toHaveLength(60);
  expect(document.body.textContent).not.toContain(' v1');
});

test('a refresh deeper than the route maximum follows the cursor, keeping the old rows until the end', async () => {
  tallNow();
  const server = serveRows(150);
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(document.querySelectorAll('.entry')).toHaveLength(150));
  guide.grid.mockClear();
  server.version = 2;
  server.rowsAtCall.length = 0;
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 150 v2'));
  expect(askedFor()).toEqual([[null, 100], ['100', 50]]);
  expect(server.rowsAtCall).toEqual([150, 150]);
  expect(document.querySelectorAll('.entry')).toHaveLength(150);
  expect(document.body.textContent).not.toContain(' v1');
});

test('paging waits while a refresh is in flight, then carries on from the refreshed rows', async () => {
  tallNow();
  Object.defineProperty(window, 'innerHeight', innerHeight); // a phone-sized window: 30 rows do not reach the end
  const server = serveRows(60);
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(document.querySelectorAll('.entry').length).toBeGreaterThan(0));
  expect(askedFor()).toEqual([[null, undefined]]);
  let resolveQuiet!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveQuiet = r)));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(askedFor()).toEqual([[null, undefined], [null, 30]]);
  // The reader reaches the end of the list while the refresh is out.
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100_000 });
  window.dispatchEvent(new Event('resize'));
  await vi.advanceTimersByTimeAsync(50); // jsdom's animation frames run on the faked interval
  expect(document.querySelectorAll('.entry')).toHaveLength(30); // the taller window was measured
  expect(askedFor()).toHaveLength(2);
  server.version = 2;
  const fresh = Array.from({ length: 30 }, (_, i) =>
    row(i + 1, { programmes: [show(i + 1, `Show ${i + 1} v2`, NOW_SEC - 600, NOW_SEC + 600)] }),
  );
  resolveQuiet({ items: fresh, nextCursor: '30' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 60 v2'));
  expect(askedFor()).toEqual([[null, undefined], [null, 30], ['30', undefined]]);
  expect(document.querySelectorAll('.entry')).toHaveLength(60);
});

test('the minute tick does not fetch while the app is hidden; coming back refreshes', async () => {
  tallNow();
  let visibility = 'hidden';
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(1));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(guide.grid).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(guide.grid).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(guide.grid).toHaveBeenCalledTimes(3);
});

test('a refresh that lands after the filter changes is ignored and asks for nothing more', async () => {
  tallNow();
  guide.grid.mockResolvedValueOnce(page(row(1), row(2)));
  const props = $state({ filter: 'category:4', label: 'Sports', tz: 'UTC' });
  app = mount(NowList, { target: document.body, props });
  flushSync();
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 1', 'Ch 2']));
  let resolveQuiet!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveQuiet = r)));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(guide.grid).toHaveBeenCalledTimes(2);
  guide.grid.mockResolvedValueOnce(page(row(5)));
  props.filter = 'favourites';
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 5']));
  // Short of the old depth with more to come, so a refresh that missed the change would ask again.
  resolveQuiet({ items: [row(9)], nextCursor: 'c2' });
  await new Promise((r) => setTimeout(r, 20));
  expect(texts('.entry .title')).toEqual(['Ch 5']);
  expect(guide.grid).toHaveBeenCalledTimes(3);
});

test('a tick during the first load does not abort it', async () => {
  tallNow();
  let resolveFirst!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(guide.grid).toHaveBeenCalledTimes(1);
  expect((guide.grid.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
  resolveFirst(page(row(1)));
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 1']));
});

test('a failed load never shows the empty text', async () => {
  tallNow();
  // A refresh with no rows (e.g. after an error) that fails shows the error and Retry.
  guide.grid.mockRejectedValueOnce(new Error('boom'));
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(document.querySelector('.retry')).not.toBeNull());
  guide.grid.mockRejectedValueOnce(new Error('boom again'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(document.querySelector('.retry')).not.toBeNull();
  expect(document.body.textContent).not.toContain('No channels');
});

test('a quiet refresh with no rows that fails shows the error, not the empty text', async () => {
  tallNow();
  guide.grid.mockResolvedValueOnce(page());
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No channels in Sports'));
  guide.grid.mockRejectedValueOnce(new Error('boom'));
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(document.querySelector('.retry')).not.toBeNull());
  expect(document.body.textContent).not.toContain('No channels');
});
