import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CatalogItem } from '@tv/shared';

const api = vi.hoisted(() => vi.fn());
vi.mock('$lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('$lib/api')>()), api }));

import { createOnNow } from './onNow.svelte.ts';

// 22:13:20 UTC on 1 January 1970: during liveItem's News at Ten (22:00–23:00).
const NOW_MS = 80_000_000;
const film = { title: 'Film', startSec: 82800, stopSec: 90000 }; // 23:00–01:00, after News at Ten
const liveItem = (over: Partial<CatalogItem> = {}) =>
  ({ id: 7, kind: 'live', catchupDays: 3, now: { title: 'News at Ten', startSec: 79200, stopSec: 82800 }, ...over }) as CatalogItem;
const itemCalls = (id = 7) => api.mock.calls.filter(([path]) => path === `/api/items/${id}`);
const serve = (item: CatalogItem | Error) =>
  api.mockImplementation(async () => {
    if (item instanceof Error) throw item;
    return item;
  });

let onNow: ReturnType<typeof createOnNow> | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW_MS);
  api.mockReset();
});
afterEach(() => {
  onNow?.destroy();
  onNow = undefined;
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

test('load resolves with the item once it arrives, and with null when the fetch fails', async () => {
  serve(liveItem());
  onNow = createOnNow();
  expect(onNow.item).toBeNull();
  await expect(onNow.load(7)).resolves.toMatchObject({ id: 7, kind: 'live' });
  expect(onNow.item?.id).toBe(7);
  expect(onNow.onNow?.title).toBe('News at Ten');
  // The same item again is not fetched again.
  await expect(onNow.load(7)).resolves.toMatchObject({ id: 7 });
  expect(itemCalls()).toHaveLength(1);

  serve(new Error('offline'));
  await expect(onNow.load(8)).resolves.toBeNull();
  expect(onNow.item).toBeNull();
  expect(onNow.onNow).toBeNull();
});

test('a newer item drops a late answer for the old one, whose waiters get null', async () => {
  let answer7!: (it: CatalogItem) => void;
  api.mockImplementation((path: string) =>
    path === '/api/items/7' ? new Promise((r) => (answer7 = r)) : Promise.resolve(liveItem({ id: 8, now: film })),
  );
  onNow = createOnNow();
  const first = onNow.load(7);
  await expect(onNow.load(8)).resolves.toMatchObject({ id: 8 });
  await expect(first).resolves.toBeNull();
  answer7(liveItem());
  await vi.advanceTimersByTimeAsync(0);
  expect(onNow.item?.id).toBe(8);
});

test('the programme on now moves to the next at its stop time, hidden until the new one arrives', async () => {
  serve(liveItem());
  onNow = createOnNow();
  await onNow.load(7);
  expect(onNow.onNow?.title).toBe('News at Ten');
  let answer!: (it: CatalogItem) => void;
  api.mockImplementation(() => new Promise((r) => (answer = r)));
  await vi.advanceTimersByTimeAsync(82_800_000 - Date.now() - 1);
  expect(itemCalls()).toHaveLength(1);
  expect(onNow.onNow?.title).toBe('News at Ten');
  await vi.advanceTimersByTimeAsync(1);
  expect(itemCalls()).toHaveLength(2);
  expect(onNow.onNow).toBeNull();
  answer(liveItem({ now: film }));
  await vi.waitFor(() => expect(onNow!.onNow?.title).toBe('Film'));
});

test('an answer whose programme has already ended by this clock is hidden and asked again 30 s later, not at once', async () => {
  serve(liveItem({ now: { title: 'Ended', startSec: 76000, stopSec: 79000 } }));
  onNow = createOnNow();
  await onNow.load(7);
  expect(onNow.onNow).toBeNull();
  serve(liveItem());
  await vi.advanceTimersByTimeAsync(29_000);
  expect(itemCalls()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(itemCalls()).toHaveLength(2);
  await vi.waitFor(() => expect(onNow!.onNow?.title).toBe('News at Ten'));
});

test('coming back to the foreground refetches the item; a hidden page does not', async () => {
  serve(liveItem());
  onNow = createOnNow();
  await onNow.load(7);
  let visibility = 'hidden';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(itemCalls()).toHaveLength(1);
  vi.setSystemTime(83_000_000);
  serve(liveItem({ now: film }));
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(onNow!.onNow?.title).toBe('Film'));
  expect(itemCalls()).toHaveLength(2);
});

test('refetch hides an ended programme at once and loads what is on now', async () => {
  serve(liveItem());
  onNow = createOnNow();
  await onNow.load(7);
  vi.setSystemTime(83_000_000); // past the stop time, before the timer has run
  let answer!: (it: CatalogItem) => void;
  api.mockImplementation(() => new Promise((r) => (answer = r)));
  const done = onNow.refetch();
  expect(onNow.onNow).toBeNull();
  answer(liveItem({ now: film }));
  await done;
  expect(onNow.onNow?.title).toBe('Film');
});

test('destroy clears the timer and stops listening for the foreground', async () => {
  serve(liveItem());
  onNow = createOnNow();
  await onNow.load(7);
  expect(vi.getTimerCount()).toBe(1);
  onNow.destroy();
  expect(vi.getTimerCount()).toBe(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(itemCalls()).toHaveLength(1);
  onNow = undefined;
});
