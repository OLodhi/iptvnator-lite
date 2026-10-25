import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, GridRow, Page, WhatsOnEntry } from '@tv/shared';

const guide = vi.hoisted(() => ({ whatsOn: vi.fn(), grid: vi.fn() }));
vi.mock('$lib/guide', () => guide);

import WhatsOn from './WhatsOn.svelte';
import { segmentQuery } from '$lib/guide/time';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const entry = (id: number, over: Partial<WhatsOnEntry> = {}): WhatsOnEntry => ({
  item: { id, providerId: 1, kind: 'live', name: `Ch ${id}`, displayName: `Ch ${id}`, logoUrl: null, catchupDays: 3, year: null, rating: null, favourite: false },
  programme: { id, title: `Show ${id}`, subtitle: null, description: null, category: null, startSec: NOW / 1000 - 600, stopSec: NOW / 1000 + 600 },
  live: true,
  catchup: true,
  ...over,
});
const page = (...items: WhatsOnEntry[]): Page<WhatsOnEntry> => ({ items, nextCursor: null });
const channelRow = (id: number): GridRow => ({ item: entry(id).item, programmes: [entry(id).programme], hasGuide: true });

const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')!;

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  guide.whatsOn.mockReset().mockResolvedValue(page());
  guide.grid.mockReset().mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerHeight', innerHeight);
  Reflect.deleteProperty(document, 'visibilityState');
});

const mountIt = (props: { filter: string; label: string; onLongPress?: (item: CatalogItem) => void }) => {
  app = mount(WhatsOn, { target: document.body, props: { ...props, tz: 'UTC' } });
  flushSync();
};
const segment = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.segments button')].find((b) => b.textContent?.trim() === name)!;

test('Now lists the channels; the other segments query their window', async () => {
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(1));
  expect(guide.grid.mock.calls[0]![0]).toMatchObject({ filter: 'category:4', from: NOW / 1000, to: NOW / 1000 + 60 });
  expect(guide.whatsOn).not.toHaveBeenCalled();
  segment('Tonight').click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  expect(guide.whatsOn.mock.calls[0]![0]).toMatchObject({
    filter: 'category:4', mode: 'range', from: Date.UTC(2026, 9, 24, 18) / 1000, to: Date.UTC(2026, 9, 25, 2) / 1000,
  });
  segment('Tomorrow').click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(2));
  expect(guide.whatsOn.mock.calls[1]![0]).toMatchObject({
    filter: 'category:4', mode: 'range', from: Date.UTC(2026, 9, 25, 6) / 1000, to: Date.UTC(2026, 9, 26, 2) / 1000,
  });
  segment('Earlier').click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(3));
  expect(guide.whatsOn.mock.calls[2]![0]).toMatchObject({ filter: 'category:4', mode: 'past', from: NOW / 1000 - 86400, to: NOW / 1000 });
  expect(guide.grid).toHaveBeenCalledTimes(1);
});

test('catch-up rows link with from and to; future rows do not link', async () => {
  const past = entry(1, { live: false, catchup: true, programme: { ...entry(1).programme, title: 'Late & Live', startSec: 1000, stopSec: 2000 } });
  const future = entry(2, { live: false, catchup: false, programme: { ...entry(2).programme, startSec: NOW / 1000 + 3600, stopSec: NOW / 1000 + 5400 } });
  const airing = entry(3);
  guide.whatsOn.mockResolvedValue(page(past, future, airing));
  mountIt({ filter: 'category:4', label: 'Sports' });
  segment('Earlier').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 2'));
  const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  // The watch page keeps the category, for its list and channel up and down.
  expect(links).toContain(`/watch?item=1&from=1000&to=2000&title=${encodeURIComponent('Late & Live')}&cat=4`);
  expect(links).toContain('/watch?item=3&cat=4');
  expect(links.some((h) => h?.includes('item=2'))).toBe(false);
  expect(document.body.textContent).toContain('↺ Catch up');
  expect(document.body.textContent).toContain('Ch 3 · until 12:10');
  expect(document.body.textContent).toContain('Ch 2 · 13:00–13:30');
  expect(document.body.textContent).toContain('Ch 1 · 00:16–00:33');
});

test('changing filter resets the list and ignores stale responses', async () => {
  let resolveOld!: (p: Page<WhatsOnEntry>) => void;
  guide.whatsOn.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
  const props = $state({ filter: 'category:4', label: 'Sports' });
  app = mount(WhatsOn, { target: document.body, props });
  flushSync();
  segment('Earlier').click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  guide.whatsOn.mockResolvedValueOnce(page(entry(2)));
  props.filter = 'favourites';
  props.label = 'Favourites';
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 2'));
  expect(guide.whatsOn.mock.calls[1]![0]).toMatchObject({ filter: 'favourites', mode: 'past' });
  resolveOld(page(entry(1)));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).not.toContain('Show 1');
  expect(document.body.textContent).toContain('Show 2');
});

test('pages on scroll end', async () => {
  guide.whatsOn.mockResolvedValueOnce({ items: [entry(1), entry(2)], nextCursor: 'c2' });
  guide.whatsOn.mockResolvedValueOnce(page(entry(3)));
  mountIt({ filter: 'category:4', label: 'Sports' });
  segment('Tomorrow').click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(2));
  expect(guide.whatsOn.mock.calls[1]![0]).toMatchObject({ cursor: 'c2' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 3'));
});

test('an empty segment says so', async () => {
  mountIt({ filter: 'category:5', label: 'Sport' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No channels in Sport'));
  segment('Earlier').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Nothing earlier in Sport'));
  segment('Tomorrow').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Nothing on in Sport tomorrow'));
});

test('with no name for the filter yet, the empty text leaves it out', async () => {
  mountIt({ filter: 'category:5', label: '' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No channels'));
});

test('a segment with no window shows nothing more tonight without a request', async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 24, 3, 0, 0)); // 03:00 is after last night's window and before 18:00
  expect(segmentQuery('tonight', Date.now(), 'UTC')).toBeNull();
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(1));
  segment('Tonight').click();
  flushSync();
  expect(document.body.textContent).toContain('Nothing more tonight');
  expect(guide.whatsOn).not.toHaveBeenCalled();
});

test('a segment change during the first load discards the first response', async () => {
  let resolveFirst!: (p: Page<WhatsOnEntry>) => void;
  guide.whatsOn.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
  mountIt({ filter: 'category:4', label: 'Sports' });
  segment('Earlier').click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  guide.whatsOn.mockResolvedValueOnce(page(entry(2)));
  segment('Tomorrow').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 2'));
  resolveFirst(page(entry(1)));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).not.toContain('Show 1');
});

test('a page in flight when the filter changes is ignored', async () => {
  let resolveMore!: (p: Page<WhatsOnEntry>) => void;
  guide.whatsOn.mockResolvedValueOnce({ items: [entry(1)], nextCursor: 'c2' });
  guide.whatsOn.mockImplementationOnce(() => new Promise((r) => (resolveMore = r)));
  const props = $state({ filter: 'category:4', label: 'Sports', tz: 'UTC' });
  app = mount(WhatsOn, { target: document.body, props });
  flushSync();
  segment('Tonight').click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(2));
  guide.whatsOn.mockResolvedValueOnce(page(entry(5)));
  props.filter = 'favourites';
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 5'));
  resolveMore(page(entry(9)));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).not.toContain('Show 9');
  expect(document.body.textContent).not.toContain('Show 1');
});

test('an error shows Retry, which reloads from page 1', async () => {
  guide.whatsOn.mockRejectedValueOnce(new Error('boom'));
  mountIt({ filter: 'category:4', label: 'Sports' });
  segment('Earlier').click();
  await vi.waitFor(() => expect(document.querySelector('.retry')).not.toBeNull());
  guide.whatsOn.mockResolvedValueOnce(page(entry(4)));
  document.querySelector<HTMLButtonElement>('.retry')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 4'));
  expect(guide.whatsOn.mock.calls[1]![0].cursor).toBeNull();
});

test('long-pressing a row hands over its channel and swallows the tap', async () => {
  const onLongPress = vi.fn();
  const future = entry(2, { live: false, catchup: false, programme: { ...entry(2).programme, startSec: NOW / 1000 + 3600, stopSec: NOW / 1000 + 5400 } });
  guide.whatsOn.mockResolvedValue(page(entry(1), future));
  mountIt({ filter: 'category:4', label: 'Sports', onLongPress });
  segment('Tonight').click();
  await vi.waitFor(() => expect(document.querySelectorAll('.entry')).toHaveLength(2));
  // A live row, which links to the watch page, then a future one, which does not.
  for (const id of [1, 2]) {
    const row = document.querySelectorAll<HTMLElement>('.entry')[id - 1]!;
    row.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    await new Promise((r) => setTimeout(r, 560));
    expect(onLongPress).toHaveBeenLastCalledWith(expect.objectContaining({ id, displayName: `Ch ${id}` }));
    row.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    row.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); // a long-press does not also open the watch page
  }
  expect(onLongPress).toHaveBeenCalledTimes(2);
});

test('the Now list refetches every minute and when the app becomes visible, and stops on other segments', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(guide.grid).toHaveBeenCalledTimes(2);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(guide.grid).toHaveBeenCalledTimes(3);
  segment('Earlier').click();
  flushSync();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(120_000);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(guide.grid).toHaveBeenCalledTimes(3);
  expect(guide.whatsOn).toHaveBeenCalledTimes(1);
});

test('a quiet Now response that lands after a segment change is ignored and asks for nothing more', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100_000 });
  guide.grid.mockResolvedValueOnce({ items: [channelRow(1), channelRow(2)], nextCursor: null });
  mountIt({ filter: 'category:4', label: 'Sports' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 2 · until 12:10'));
  let resolveQuiet!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveQuiet = r)));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(guide.grid).toHaveBeenCalledTimes(2);
  guide.whatsOn.mockResolvedValueOnce(page(entry(5)));
  segment('Earlier').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 5'));
  // Short of the old depth with more to come, so a quiet reload that missed the change would ask again.
  resolveQuiet({ items: [channelRow(9)], nextCursor: 'c2' });
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).not.toContain('Ch 9');
  expect(document.body.textContent).toContain('Show 5');
  expect(guide.grid).toHaveBeenCalledTimes(2);
});
