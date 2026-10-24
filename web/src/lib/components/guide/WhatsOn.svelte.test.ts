import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Page, WhatsOnEntry } from '@tv/shared';

const guide = vi.hoisted(() => ({ whatsOn: vi.fn() }));
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

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  guide.whatsOn.mockReset().mockResolvedValue(page());
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const mountIt = (props: { filter: string; chipLabel: string }) => {
  app = mount(WhatsOn, { target: document.body, props });
  flushSync();
};
const segment = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.segments button')].find((b) => b.textContent?.trim() === name)!;

test('segments query the right window', async () => {
  mountIt({ filter: 'all', chipLabel: 'All' });
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  expect(guide.whatsOn.mock.calls[0]![0]).toMatchObject({ filter: 'all', mode: 'now' });
  segment('Tonight').click();
  const q = segmentQuery('tonight', NOW) as { from: number; to: number };
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(2));
  expect(guide.whatsOn.mock.calls[1]![0]).toMatchObject({ filter: 'all', mode: 'range', from: q.from, to: q.to });
});

test('catch-up rows link with from and to; future rows do not link', async () => {
  const past = entry(1, { live: false, catchup: true, programme: { ...entry(1).programme, title: 'Late & Live', startSec: 1000, stopSec: 2000 } });
  const future = entry(2, { live: false, catchup: false });
  const airing = entry(3);
  guide.whatsOn.mockResolvedValue(page(past, future, airing));
  mountIt({ filter: 'all', chipLabel: 'All' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 2'));
  const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(links).toContain(`/watch?item=1&from=1000&to=2000&title=${encodeURIComponent('Late & Live')}`);
  expect(links).toContain('/watch?item=3');
  expect(links.some((h) => h?.includes('item=2'))).toBe(false);
  expect(document.body.textContent).toContain('↺ Catch up');
  expect(document.body.textContent).toContain('Ch 3 · until');
});

test('changing chip resets the list and ignores stale responses', async () => {
  let resolveOld!: (p: Page<WhatsOnEntry>) => void;
  guide.whatsOn.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
  const props = $state({ filter: 'all', chipLabel: 'All' });
  app = mount(WhatsOn, { target: document.body, props });
  flushSync();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  guide.whatsOn.mockResolvedValueOnce(page(entry(2)));
  props.filter = 'favourites';
  props.chipLabel = 'Favourites';
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 2'));
  resolveOld(page(entry(1)));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).not.toContain('Show 1');
  expect(document.body.textContent).toContain('Show 2');
});

test('pages on scroll end', async () => {
  guide.whatsOn.mockResolvedValueOnce({ items: [entry(1), entry(2)], nextCursor: 'c2' });
  guide.whatsOn.mockResolvedValueOnce(page(entry(3)));
  mountIt({ filter: 'all', chipLabel: 'All' });
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(2));
  expect(guide.whatsOn.mock.calls[1]![0]).toMatchObject({ cursor: 'c2' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 3'));
});

test('an empty segment says so', async () => {
  mountIt({ filter: 'category:5', chipLabel: 'Sport' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Nothing on in Sport right now'));
});

test('a segment with no window shows nothing more tonight without a request', async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 24, 3, 0, 0));
  if (segmentQuery('tonight', Date.now()) !== null) return; // zone-dependent: only meaningful when the window is empty
  mountIt({ filter: 'all', chipLabel: 'All' });
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  guide.whatsOn.mockClear();
  segment('Tonight').click();
  flushSync();
  expect(document.body.textContent).toContain('Nothing more tonight');
  expect(guide.whatsOn).not.toHaveBeenCalled();
});
