import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, GridRow, GuideMeta, Page, Programme } from '@tv/shared';

const guide = vi.hoisted(() => ({ grid: vi.fn(), programmes: vi.fn() }));
vi.mock('$lib/guide', () => guide);

import GuideGrid from './GuideGrid.svelte';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0) / 1000;
const FROM = NOW - 3600; // the opening window: floor30(now − 60 min) …
const TO = FROM + 6 * 3600; // … plus 6 h
const PAGE = 6 * 3600;
const MIN = 60;
const at = (min: number) => NOW + min * MIN;

const item = (id: number, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id, providerId: 1, kind: 'live', name: `UK| Ch ${id}`, displayName: `Ch ${id}`, logoUrl: null, catchupDays: 3, year: null, rating: null, favourite: false, ...over,
});
const prog = (id: number, startSec: number, stopSec: number, title = `Show ${id}`): Programme => ({
  id, title, subtitle: null, description: null, category: null, startSec, stopSec,
});
const row = (id: number, programmes: Programme[] = [], over: Partial<GridRow> = {}, itemOver: Partial<CatalogItem> = {}): GridRow => ({
  item: item(id, itemOver), programmes, hasGuide: true, ...over,
});
const page = (rows: GridRow[], nextCursor: string | null = null): Page<GridRow> => ({ items: rows, nextCursor });
const meta = (over: Partial<GuideMeta> = {}): GuideMeta => ({
  providerId: 1,
  chips: [{ filter: 'all', label: 'All' }, { filter: 'favourites', label: 'Favourites' }],
  prefs: { view: 'grid', filter: 'all' },
  range: { fromSec: NOW - 7 * 86400, toSec: NOW + 2 * 86400 },
  status: null,
  ...over,
});

let app: ReturnType<typeof mount> | undefined;
let scrollY = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  scrollY = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  // The rows follow the window's scroll: the list's top moves up as the window scrolls down.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ top: -scrollY, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: -scrollY, toJSON() {} }) as DOMRect,
  );
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  guide.grid.mockReset().mockResolvedValue(page([]));
  guide.programmes.mockReset().mockResolvedValue({});
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function mountIt(props: { meta: GuideMeta; filter: string } = { meta: meta(), filter: 'all' }) {
  app = mount(GuideGrid, { target: document.body, props: { ...props, tz: 'UTC' } });
  flushSync();
}
const scroller = () => document.querySelector<HTMLDivElement>('.scroller')!;
const content = () => document.querySelector<HTMLDivElement>('.content')!;

/** Scrolls the grid sideways in a viewport `clientWidth` wide; the scroll width is the content's width. */
function scrollSideways(x: number, clientWidth = 390) {
  const el = scroller();
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollWidth', { get: () => parseFloat(content().style.width), configurable: true });
  el.scrollLeft = x;
  el.dispatchEvent(new Event('scroll'));
  flushSync();
}
function scrollWindow(y: number) {
  scrollY = y;
  window.dispatchEvent(new Event('scroll'));
  flushSync();
}
const blockTitled = (title: string) => [...document.querySelectorAll<HTMLElement>('.block')].find((b) => b.textContent?.includes(title));

test('renders rows and a now-line at the right offset', async () => {
  guide.grid.mockResolvedValue(page([row(1, [prog(10, at(-30), at(30))]), row(2)]));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 2'));
  expect(guide.grid).toHaveBeenCalledTimes(1);
  expect(guide.grid.mock.calls[0]![0]).toEqual({ filter: 'all', from: FROM, to: TO, cursor: null });
  // 72 px channel column + 60 minutes past the window start at 3 px a minute.
  expect(document.querySelector<HTMLElement>('.now-line')!.style.left).toBe('252px');
  expect(content().style.width).toBe(`${72 + 6 * 60 * 3}px`);
  const ticks = [...document.querySelectorAll('.tick')].map((t) => t.textContent?.trim());
  expect(ticks[0]).toBe('11:00');
  expect(ticks[1]).toBe('11:30');
  expect(ticks.at(-1)).toBe('16:30');
  expect(blockTitled('Show 10')?.textContent).toContain('11:30');
  // Opens with now − 30 min at the left edge, just right of the channel column.
  expect(scroller().scrollLeft).toBe(90);
});

test('catch-up block links with from and to', async () => {
  guide.grid.mockResolvedValue(
    page([
      row(1, [
        prog(10, at(-60), at(-30), 'Late & Live'),
        prog(11, at(-30), at(-25), 'Short'), // 15 px: too narrow for text
        prog(12, at(-25), at(30), 'News'),
        prog(13, at(30), at(60), 'Later'),
      ]),
      row(2, [prog(20, at(-60), at(-30), 'Old')], {}, { catchupDays: 0 }),
    ]),
  );
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Later'));
  const hrefs = [...document.querySelectorAll('a.block')].map((a) => a.getAttribute('href'));
  expect(hrefs).toEqual([
    `/watch?item=1&from=${at(-60)}&to=${at(-30)}&title=${encodeURIComponent('Late & Live')}`,
    `/watch?item=1&from=${at(-30)}&to=${at(-25)}&title=Short`,
    '/watch?item=1',
  ]);
  expect(blockTitled('Late & Live')!.textContent).toContain('↺');
  const short = document.querySelector<HTMLAnchorElement>(`a.block[href*="title=Short"]`)!;
  expect(short.textContent?.trim()).toBe('');
  expect(short.getAttribute('aria-label')).toContain('Short');
  expect(blockTitled('Later')!.tagName).not.toBe('A');
  expect(blockTitled('Old')!.tagName).not.toBe('A');
  expect(blockTitled('Old')!.textContent).not.toContain('↺');
});

test('extending right fetches programmes for loaded rows', async () => {
  guide.grid.mockResolvedValue(page([row(1, [prog(10, TO - 1800, TO + 1800, 'Straddles')]), row(2), row(3, [], { hasGuide: false })]));
  guide.programmes.mockResolvedValue({ '1': [prog(10, TO - 1800, TO + 1800, 'Straddles'), prog(11, TO + 1800, TO + 3600, 'Evening')], '2': [] });
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Straddles'));
  scrollSideways(500); // 1152 − 500 − 390 = 262 px left: within one screen of the right edge
  await vi.waitFor(() => expect(document.body.textContent).toContain('Evening'));
  expect(guide.programmes).toHaveBeenCalledTimes(1);
  expect(guide.programmes.mock.calls[0]!.slice(0, 3)).toEqual([[1, 2], TO, TO + PAGE]);
  expect([...document.querySelectorAll('.block')].filter((b) => b.textContent?.includes('Straddles'))).toHaveLength(1);
  expect(content().style.width).toBe(`${72 + 12 * 60 * 3}px`);
  expect(scroller().scrollLeft).toBe(500);
});

test('channel cell plays live', async () => {
  guide.grid.mockResolvedValue(page([row(7, [prog(70, at(-10), at(20))])]));
  mountIt();
  await vi.waitFor(() => expect(document.querySelector('a.channel')).not.toBeNull());
  const cell = document.querySelector<HTMLAnchorElement>('a.channel')!;
  expect(cell.getAttribute('href')).toBe('/watch?item=7');
  expect(cell.textContent).toContain('Ch 7');
});

test('extending left keeps the view in place, down to the start of the guide', async () => {
  guide.grid.mockResolvedValue(page([row(1, [prog(10, at(-30), at(30))])]));
  guide.programmes.mockResolvedValue({ '1': [prog(9, FROM - 3600, FROM, 'Earlier on')] });
  mountIt({ meta: meta({ range: { fromSec: FROM - 2 * 3600, toSec: NOW + 86400 } }), filter: 'all' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 10'));
  scrollSideways(200);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Earlier on'));
  expect(guide.programmes.mock.calls[0]!.slice(0, 3)).toEqual([[1], FROM - 2 * 3600, FROM]);
  // Two hours (360 px) were added on the left, so the scroll moves by as much and the view stays put.
  expect(scroller().scrollLeft).toBe(560);
  expect(document.querySelector<HTMLElement>('.now-line')!.style.left).toBe(`${72 + 3 * 60 * 3}px`);
  expect(document.querySelector('.tick')?.textContent?.trim()).toBe('09:00');
  scrollSideways(100);
  flushSync();
  await new Promise((r) => setTimeout(r, 10));
  expect(guide.programmes).toHaveBeenCalledTimes(1); // already at the start of the guide
});

test('a later row page gets programmes for the whole loaded window', async () => {
  const first = Array.from({ length: 30 }, (_, i) => row(i + 1, [prog(1000 + i, at(-30), at(30))]));
  guide.grid.mockResolvedValueOnce(page(first, 'c2')).mockResolvedValueOnce(page([row(31, [prog(31, at(-30), at(30))])]));
  guide.programmes.mockImplementation(async (ids: number[]) => Object.fromEntries(ids.map((id) => [String(id), id === 31 ? [prog(3100, TO, TO + 3600, 'Late film')] : []])));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  expect(guide.grid).toHaveBeenCalledTimes(1);
  scrollSideways(500);
  await vi.waitFor(() => expect(guide.programmes).toHaveBeenCalledTimes(1));
  scrollWindow(31 * 56);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Late film'));
  expect(guide.grid.mock.calls[1]![0]).toEqual({ filter: 'all', from: FROM, to: TO, cursor: 'c2' });
  expect(guide.programmes.mock.calls[1]!.slice(0, 3)).toEqual([[31], TO, TO + PAGE]);
});

test('a chip change starts again from page 1 and ignores stale responses', async () => {
  guide.grid.mockResolvedValueOnce(page([row(1, [prog(10, at(-30), at(30))])]));
  guide.programmes.mockResolvedValue({ '1': [] });
  const props = $state({ meta: meta(), filter: 'all', tz: 'UTC' });
  app = mount(GuideGrid, { target: document.body, props });
  flushSync();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  scrollSideways(500);
  await vi.waitFor(() => expect(content().style.width).toBe(`${72 + 12 * 60 * 3}px`));

  let resolveOld!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
  props.filter = 'favourites';
  flushSync();
  expect(content().style.width).toBe(`${72 + 6 * 60 * 3}px`);
  expect(scroller().scrollLeft).toBe(0);
  expect(document.body.textContent).not.toContain('Ch 1');
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(2));
  expect(guide.grid.mock.calls[1]![0]).toEqual({ filter: 'favourites', from: FROM, to: TO, cursor: null });

  guide.grid.mockResolvedValueOnce(page([row(2)]));
  props.filter = 'all';
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 2'));
  resolveOld(page([row(9)]));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).not.toContain('Ch 9');
  expect(scroller().scrollLeft).toBe(90);
});

test('rows without a guide say so', async () => {
  guide.grid.mockResolvedValue(page([row(4, [], { hasGuide: false })]));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('No guide information'));
});

test('only a window of rows renders, following the window scroll', async () => {
  guide.grid.mockResolvedValue(page(Array.from({ length: 100 }, (_, i) => row(i + 1)), 'c2'));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  const rendered = () => [...document.querySelectorAll('a.channel .name')].map((a) => a.textContent?.trim());
  expect(rendered().length).toBeLessThan(30);
  scrollWindow(50 * 56);
  expect(rendered()).toContain('Ch 51');
  expect(rendered()).not.toContain('Ch 1');
  expect(guide.grid).toHaveBeenCalledTimes(1); // far from the end: no next page yet
});

test('programmes requests are batched by 200 items', async () => {
  guide.grid.mockResolvedValue(page(Array.from({ length: 250 }, (_, i) => row(i + 1))));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  scrollSideways(500);
  await vi.waitFor(() => expect(guide.programmes).toHaveBeenCalledTimes(2));
  expect(guide.programmes.mock.calls.map((c) => (c[0] as number[]).length)).toEqual([200, 50]);
  expect((guide.programmes.mock.calls[1]![0] as number[])[0]).toBe(201);
});

test('an error shows Retry, which reloads from page 1', async () => {
  guide.grid.mockRejectedValueOnce(new Error('boom'));
  mountIt();
  await vi.waitFor(() => expect(document.querySelector('.retry')).not.toBeNull());
  guide.grid.mockResolvedValueOnce(page([row(5)]));
  document.querySelector<HTMLButtonElement>('.retry')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 5'));
  expect(guide.grid.mock.calls[1]![0]).toMatchObject({ cursor: null });
  expect(document.querySelector('.retry')).toBeNull();
});

test('an empty filter says so', async () => {
  mountIt({ meta: meta(), filter: 'favourites' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No channels in Favourites'));
});
