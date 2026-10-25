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
const EARLIER = FROM - PAGE; // the page before the opening window, loaded with page 1
const MIN = 60;
const at = (min: number) => NOW + min * MIN;
const px = (fromSec: number, toSec: number) => ((toSec - fromSec) / 60) * 3;

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

function mountIt(props: { meta: GuideMeta; filter: string; onLongPress?: (item: CatalogItem) => void } = { meta: meta(), filter: 'all' }) {
  app = mount(GuideGrid, { target: document.body, props: { ...props, tz: 'UTC' } });
  flushSync();
}
const scroller = () => document.querySelector<HTMLDivElement>('.scroller')!;
const content = () => document.querySelector<HTMLDivElement>('.content')!;
const settle = () => new Promise((r) => setTimeout(r, 20));

/** Gives the scroller a viewport `clientWidth` wide; its scroll width is the content's width. */
function sizeScroller(clientWidth = 390) {
  const el = scroller();
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollWidth', { get: () => parseFloat(content().style.width), configurable: true });
}
function scrollSideways(x: number, clientWidth = 390) {
  sizeScroller(clientWidth);
  scroller().scrollLeft = x;
  scroller().dispatchEvent(new Event('scroll'));
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
  // 72 px channel column + 7 hours past the window start (the earlier page and an hour) at 3 px a minute.
  expect(document.querySelector<HTMLElement>('.now-line')!.style.left).toBe(`${72 + 7 * 60 * 3}px`);
  expect(content().style.width).toBe(`${72 + 12 * 60 * 3}px`);
  const ticks = [...document.querySelectorAll('.tick')].map((t) => t.textContent?.trim());
  expect(ticks[0]).toBe('05:00');
  expect(ticks[1]).toBe('05:30');
  expect(ticks.at(-1)).toBe('16:30');
  expect(blockTitled('Show 10')?.textContent).toContain('11:30');
  // Opens with now − 30 min at the left edge, just right of the channel column.
  expect(scroller().scrollLeft).toBe(px(EARLIER, NOW - 1800));
});

test('opens on its final layout: the page before comes with page 1 and nothing is compensated', async () => {
  guide.grid.mockResolvedValue(page([row(1, [prog(10, at(-30), at(30))]), row(2)]));
  guide.programmes.mockResolvedValue({ '1': [prog(9, FROM - 3600, FROM, 'Before')], '2': [] });
  mountIt();
  const el = scroller();
  let sets = 0;
  let value = el.scrollLeft;
  Object.defineProperty(el, 'scrollLeft', {
    get: () => value,
    set: (v: number) => {
      sets++;
      value = v;
    },
    configurable: true,
  });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Before'));
  expect(guide.programmes).toHaveBeenCalledTimes(1);
  expect(guide.programmes.mock.calls[0]!.slice(0, 3)).toEqual([[1, 2], EARLIER, FROM]);
  expect(sets).toBe(1);
  expect(value).toBe(1170);
  // The scroll event the opening position fires is more than a screen from either end: no extension, no compensation.
  sizeScroller();
  el.dispatchEvent(new Event('scroll'));
  flushSync();
  await settle();
  expect(guide.programmes).toHaveBeenCalledTimes(1);
  expect(sets).toBe(1);
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

test('catch-up reaches back only as far as the channel keeps it', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW * 1000);
  guide.grid.mockResolvedValue(page([row(1, [prog(10, at(-60), at(-45), 'Too old'), prog(11, at(-45), at(-30), 'Just in')], {}, { catchupDays: 1 })]));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Just in'));
  // A day later, less 50 minutes: 'Too old' started a day and 10 minutes ago, 'Just in' a day less 5 minutes ago.
  vi.setSystemTime((NOW + 86400 - 50 * MIN - 30) * 1000);
  vi.advanceTimersByTime(30_000); // the shared clock ticks
  flushSync();
  expect(blockTitled('Too old')!.tagName).not.toBe('A');
  expect(blockTitled('Just in')!.getAttribute('href')).toBe(`/watch?item=1&from=${at(-45)}&to=${at(-30)}&title=${encodeURIComponent('Just in')}`);
});

test('narrow blocks keep their exact width, and every block has a name', async () => {
  guide.grid.mockResolvedValue(
    page([
      row(1, [prog(10, at(60), at(65), 'Blip'), prog(11, at(65), at(120), 'Feature')]),
      row(2, [prog(20, at(-60), at(-30), 'Gone')], {}, { catchupDays: 0 }),
    ]),
  );
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Feature'));
  const blip = document.querySelector<HTMLElement>('.block[aria-label^="Blip"]')!;
  expect(blip.classList.contains('narrow')).toBe(true);
  expect(blip.style.width).toBe('13px'); // 5 minutes is 15 px, less the 2 px gap to the next block
  expect(blip.style.left).toBe(`${px(EARLIER, at(60))}px`);
  expect(blip.textContent?.trim()).toBe('');
  expect(blip.getAttribute('aria-label')).toBe('Blip, 13:00–13:05');
  expect(blockTitled('Feature')!.classList.contains('narrow')).toBe(false);
  expect(blockTitled('Feature')!.getAttribute('aria-label')).toBe('Feature, 13:05–14:00');
  expect(blockTitled('Gone')!.getAttribute('aria-label')).toBe('Gone, 11:00–11:30');
});

test('extending right fetches programmes for loaded rows', async () => {
  guide.grid.mockResolvedValue(page([row(1, [prog(10, TO - 1800, TO + 1800, 'Straddles')]), row(2), row(3, [], { hasGuide: false })]));
  guide.programmes.mockResolvedValueOnce({});
  guide.programmes.mockResolvedValueOnce({ '1': [prog(10, TO - 1800, TO + 1800, 'Straddles'), prog(11, TO + 1800, TO + 3600, 'Evening')], '2': [] });
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Straddles'));
  expect(guide.programmes.mock.calls[0]!.slice(0, 3)).toEqual([[1, 2], EARLIER, FROM]);
  scrollSideways(1500); // 2232 − 1500 − 390 = 342 px left: within one screen of the right edge
  await vi.waitFor(() => expect(document.body.textContent).toContain('Evening'));
  expect(guide.programmes).toHaveBeenCalledTimes(2);
  expect(guide.programmes.mock.calls[1]!.slice(0, 3)).toEqual([[1, 2], TO, TO + PAGE]);
  expect([...document.querySelectorAll('.block')].filter((b) => b.textContent?.includes('Straddles'))).toHaveLength(1);
  expect(content().style.width).toBe(`${72 + 18 * 60 * 3}px`);
  expect(scroller().scrollLeft).toBe(1500);
});

test('extending right stops at the end of the guide', async () => {
  guide.grid.mockResolvedValue(page([row(1)]));
  mountIt({ meta: meta({ range: { fromSec: FROM, toSec: TO + 2 * 3600 } }), filter: 'all' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  expect(guide.programmes).not.toHaveBeenCalled(); // the guide starts at the opening window
  scrollSideways(500);
  await vi.waitFor(() => expect(content().style.width).toBe(`${72 + 8 * 60 * 3}px`));
  expect(guide.programmes.mock.calls[0]!.slice(0, 3)).toEqual([[1], TO, TO + 2 * 3600]);
  scrollSideways(1100); // 22 px from the right edge, which is the end of the guide
  await settle();
  expect(guide.programmes).toHaveBeenCalledTimes(1);
});

test('channel cell plays live', async () => {
  guide.grid.mockResolvedValue(page([row(7, [prog(70, at(-10), at(20))])]));
  mountIt();
  await vi.waitFor(() => expect(document.querySelector('a.channel')).not.toBeNull());
  const cell = document.querySelector<HTMLAnchorElement>('a.channel')!;
  expect(cell.getAttribute('href')).toBe('/watch?item=7');
  expect(cell.textContent).toContain('Ch 7');
});

test('a category or favourites guide keeps its category in the channel and catch-up links', async () => {
  guide.grid.mockResolvedValue(page([row(7, [prog(71, at(-60), at(-30), 'Old'), prog(70, at(-30), at(20), 'On')])]));
  mountIt({ meta: meta(), filter: 'category:4' });
  await vi.waitFor(() => expect(document.querySelector('a.channel')).not.toBeNull());
  expect(document.querySelector('a.channel')!.getAttribute('href')).toBe('/watch?item=7&cat=4');
  expect([...document.querySelectorAll('a.block')].map((a) => a.getAttribute('href'))).toEqual([
    `/watch?item=7&from=${at(-60)}&to=${at(-30)}&title=Old&cat=4`,
    '/watch?item=7&cat=4',
  ]);
  unmount(app!);
  app = undefined;
  mountIt({ meta: meta(), filter: 'favourites' });
  await vi.waitFor(() => expect(document.querySelector('a.channel')).not.toBeNull());
  expect(document.querySelector('a.channel')!.getAttribute('href')).toBe('/watch?item=7&cat=favourites');
});

test('long-pressing a channel cell hands over its channel and swallows the tap', async () => {
  const onLongPress = vi.fn();
  guide.grid.mockResolvedValue(page([row(6), row(7, [prog(70, at(-10), at(20))])]));
  mountIt({ meta: meta(), filter: 'category:4', onLongPress });
  await vi.waitFor(() => expect(document.querySelectorAll('a.channel').length).toBe(2));
  const cell = document.querySelectorAll<HTMLAnchorElement>('a.channel')[1]!;
  cell.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  await new Promise((r) => setTimeout(r, 560));
  expect(onLongPress).toHaveBeenCalledTimes(1);
  expect(onLongPress.mock.calls[0]![0]).toMatchObject({ id: 7, displayName: 'Ch 7' });
  cell.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  cell.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true); // no navigation to the watch page
});

test('extending left keeps the view in place, down to the start of the guide', async () => {
  const start = EARLIER - 2 * 3600;
  guide.grid.mockResolvedValue(page([row(1, [prog(10, at(-30), at(30))])]));
  guide.programmes.mockResolvedValueOnce({});
  guide.programmes.mockResolvedValueOnce({ '1': [prog(9, EARLIER - 3600, EARLIER, 'Earlier on')] });
  mountIt({ meta: meta({ range: { fromSec: start, toSec: NOW + 86400 } }), filter: 'all' });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Show 10'));
  scrollSideways(200);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Earlier on'));
  expect(guide.programmes.mock.calls[1]!.slice(0, 3)).toEqual([[1], start, EARLIER]);
  // Two hours (360 px) were added on the left, so the scroll moves by as much and the view stays put.
  expect(scroller().scrollLeft).toBe(560);
  expect(document.querySelector<HTMLElement>('.now-line')!.style.left).toBe(`${72 + px(start, NOW)}px`);
  expect(document.querySelector('.tick')?.textContent?.trim()).toBe('03:00');
  scrollSideways(100);
  await settle();
  expect(guide.programmes).toHaveBeenCalledTimes(2); // already at the start of the guide
});

test('the ruler follows the sideways scroll', async () => {
  guide.grid.mockResolvedValue(page([row(1)]));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  const track = document.querySelector<HTMLElement>('.ruler-track')!;
  expect(track.style.transform).toBe('translateX(-1170px)');
  scrollSideways(1300);
  expect(track.style.transform).toBe(`translateX(-${scroller().scrollLeft}px)`);
  expect(scroller().scrollLeft).toBe(1300);
});

test('a later row page gets programmes for the whole loaded window', async () => {
  const first = Array.from({ length: 30 }, (_, i) => row(i + 1, [prog(1000 + i, at(-30), at(30))]));
  guide.grid.mockResolvedValueOnce(page(first, 'c2')).mockResolvedValueOnce(page([row(31, [prog(31, at(-30), at(30))])]));
  guide.programmes.mockImplementation(async (ids: number[], from: number) =>
    Object.fromEntries(ids.map((id) => [String(id), id === 31 && from === TO ? [prog(3100, TO, TO + 3600, 'Late film')] : []])),
  );
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  expect(guide.grid).toHaveBeenCalledTimes(1);
  scrollSideways(1500);
  await vi.waitFor(() => expect(guide.programmes).toHaveBeenCalledTimes(2));
  scrollWindow(31 * 56);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Late film'));
  expect(guide.grid.mock.calls[1]![0]).toEqual({ filter: 'all', from: FROM, to: TO, cursor: 'c2' });
  expect(guide.programmes.mock.calls.slice(2).map((c) => c.slice(0, 3))).toEqual([
    [[31], EARLIER, FROM],
    [[31], TO, TO + PAGE],
  ]);
});

test('a filter change starts again from page 1 and ignores stale responses', async () => {
  guide.grid.mockResolvedValueOnce(page([row(1, [prog(10, at(-30), at(30))])]));
  guide.programmes.mockResolvedValue({ '1': [] });
  const props = $state({ meta: meta(), filter: 'all', tz: 'UTC' });
  app = mount(GuideGrid, { target: document.body, props });
  flushSync();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  scrollSideways(1500);
  await vi.waitFor(() => expect(content().style.width).toBe(`${72 + 18 * 60 * 3}px`));

  let resolveOld!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
  props.filter = 'favourites';
  flushSync();
  expect(content().style.width).toBe(`${72 + 12 * 60 * 3}px`);
  expect(scroller().scrollLeft).toBe(0);
  expect(document.body.textContent).not.toContain('Ch 1');
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(2));
  expect(guide.grid.mock.calls[1]![0]).toEqual({ filter: 'favourites', from: FROM, to: TO, cursor: null });

  guide.grid.mockResolvedValueOnce(page([row(2)]));
  props.filter = 'all';
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 2'));
  resolveOld(page([row(9)]));
  await settle();
  expect(document.body.textContent).not.toContain('Ch 9');
  expect(scroller().scrollLeft).toBe(1170);
});

test('an extension in flight when the filter changes is ignored', async () => {
  const start = EARLIER - PAGE;
  guide.grid.mockResolvedValueOnce(page([row(1)])).mockResolvedValueOnce(page([row(2)]));
  let resolveStale!: (found: Record<string, Programme[]>) => void;
  guide.programmes.mockResolvedValueOnce({}).mockImplementationOnce(() => new Promise((r) => (resolveStale = r)));
  const props = $state({ meta: meta({ range: { fromSec: start, toSec: NOW + 86400 } }), filter: 'all', tz: 'UTC' });
  app = mount(GuideGrid, { target: document.body, props });
  flushSync();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  scrollSideways(200);
  await vi.waitFor(() => expect(guide.programmes).toHaveBeenCalledTimes(2));
  expect(guide.programmes.mock.calls[1]!.slice(0, 3)).toEqual([[1], start, EARLIER]);

  props.filter = 'favourites';
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 2'));
  expect(scroller().scrollLeft).toBe(1170);
  resolveStale({ '1': [prog(5, start, start + 3600, 'Stale')] });
  await settle();
  expect(document.body.textContent).not.toContain('Stale');
  expect(content().style.width).toBe(`${72 + 12 * 60 * 3}px`);
  expect(scroller().scrollLeft).toBe(1170);
});

test('coming back to the app follows now once it nears the end of the loaded window', async () => {
  guide.grid.mockResolvedValue(page([row(1)]));
  mountIt();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 1'));
  sizeScroller();
  vi.setSystemTime((NOW + 10 * MIN) * 1000); // 4 h 50 min from the end of the window: more than a screen
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(guide.grid).toHaveBeenCalledTimes(1);

  vi.setSystemTime((NOW + 3 * 3600) * 1000); // 2 h (360 px) from the end: within a screen
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(2));
  expect(guide.grid.mock.calls[1]![0]).toEqual({ filter: 'all', from: FROM + 3 * 3600, to: TO + 3 * 3600, cursor: null });

  unmount(app!);
  app = undefined;
  vi.setSystemTime((NOW + 86400) * 1000);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(guide.grid).toHaveBeenCalledTimes(2);
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
  mountIt({ meta: meta(), filter: 'category:4' });
  await vi.waitFor(() => expect(document.querySelector('.empty')?.textContent).toBe('No channels here.'));
});
