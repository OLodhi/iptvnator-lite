import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, GridRow, GuideMeta, GuidePrefs, GuideView, Page, WhatsOnEntry } from '@tv/shared';

const route = vi.hoisted(() => ({ params: { kind: 'movie', categoryId: '4' } as Record<string, string> }));
const me = vi.hoisted(() => ({ browse: vi.fn(), favourite: vi.fn(), unfavourite: vi.fn() }));
const net = vi.hoisted(() => ({ api: vi.fn() }));
const guide = vi.hoisted(() => ({
  guideMeta: vi.fn(), saveGuidePrefs: vi.fn(), whatsOn: vi.fn(), grid: vi.fn(), programmes: vi.fn(), guideSources: vi.fn(), setGuideSource: vi.fn(),
}));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$lib/me', () => me);
vi.mock('$lib/api', async (orig) => ({ ...(await orig<typeof import('$lib/api')>()), api: net.api }));
vi.mock('$lib/guide', () => guide);

import Category from './+page.svelte';
import { rememberCategories } from '$lib/categoryNames';

// Reactive, as SvelteKit's own is, so a test can move the mounted page to another category.
const params = $state({ current: route.params });
Object.defineProperty(route, 'params', {
  get: () => params.current,
  set: (v: Record<string, string>) => {
    params.current = v;
  },
});

const item = (id: number, kind: CatalogItem['kind'] = 'movie'): CatalogItem => ({
  id, providerId: 1, kind, name: `m${id}`, displayName: `Movie ${id}`, logoUrl: null,
  catchupDays: null, year: null, rating: null, favourite: false,
});
const pageOf = (ids: number[], nextCursor: string | null): Page<CatalogItem> => ({ items: ids.map((id) => item(id)), nextCursor });
const channel = (id: number): CatalogItem => ({ ...item(id, 'live'), name: `UK| Ch ${id}`, displayName: `Ch ${id}` });
const rows = (...ids: number[]): Page<GridRow> => ({ items: ids.map((id) => ({ item: channel(id), programmes: [], hasGuide: false })), nextCursor: null });
const meta: GuideMeta = { providerId: 1, chips: [], prefs: { view: 'grid', filter: 'all' }, range: null, status: null };
const metaWith = (view: GuideView): GuideMeta => ({ ...meta, prefs: { ...meta.prefs, view } });
const onNow = (id: number): WhatsOnEntry => {
  const now = Math.floor(Date.now() / 1000);
  return {
    item: channel(id),
    programme: { id, title: `Show ${id}`, subtitle: null, description: null, category: null, startSec: now - 600, stopSec: now + 600 },
    live: true,
    catchup: false,
  };
};
const whatsOnPage = (...ids: number[]): Page<WhatsOnEntry> => ({ items: ids.map(onNow), nextCursor: null });

let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  route.params = { kind: 'movie', categoryId: '4' };
  me.browse.mockReset().mockResolvedValue({ categories: [], pinned: [] });
  me.favourite.mockReset().mockResolvedValue(undefined);
  me.unfavourite.mockReset().mockResolvedValue(undefined);
  net.api.mockReset();
  guide.guideMeta.mockReset().mockResolvedValue(meta);
  guide.saveGuidePrefs.mockReset().mockResolvedValue(undefined);
  guide.whatsOn.mockReset().mockResolvedValue(whatsOnPage());
  guide.grid.mockReset().mockResolvedValue(rows(1, 2));
  guide.programmes.mockReset().mockResolvedValue({});
  guide.guideSources.mockReset().mockResolvedValue([]);
  guide.setGuideSource.mockReset().mockResolvedValue(undefined);
  rememberCategories({ categories: [{ id: 4, displayName: 'Action', itemCount: 2, pinned: false }], pinned: [] } as never);
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('titles the screen with the category name without a browse request', async () => {
  net.api.mockResolvedValue(pageOf([1], null));
  app = mount(Category, { target: document.body });
  flushSync();
  expect(document.querySelector('h1')?.textContent).toBe('Action');
  expect(me.browse).not.toHaveBeenCalled();
});

test('long-press then Favourite favourites the pressed poster', async () => {
  net.api.mockResolvedValue(pageOf([1, 2], null));
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('a.cell')).toBeTruthy());
  const cell = document.querySelectorAll<HTMLElement>('a.cell')[1]!;
  cell.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  await new Promise((r) => setTimeout(r, 560));
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>('.sheet-action')].find((b) => b.textContent === 'Favourite')!.click();
  await vi.waitFor(() => expect(me.favourite).toHaveBeenCalledWith(2));
});

test('a failed first load offers Retry, which loads again', async () => {
  net.api.mockRejectedValueOnce(new Error('down')).mockResolvedValue(pageOf([1], null));
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('.retry')).toBeTruthy());
  (document.querySelector('.retry') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.querySelector('a.cell')).toBeTruthy());
  expect(document.querySelector('.retry')).toBeNull();
});

test('a failed next page can be retried with the same cursor', async () => {
  net.api.mockResolvedValueOnce(pageOf(Array.from({ length: 12 }, (_, i) => i + 1), 'c2'));
  net.api.mockRejectedValueOnce(new Error('down'));
  net.api.mockResolvedValue(pageOf([31], null));
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('.retry')).toBeTruthy());
  expect(String(net.api.mock.calls[1]![0])).toContain('cursor=c2');
  (document.querySelector('.retry') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(net.api.mock.calls.length).toBe(3));
  expect(String(net.api.mock.calls[2]![0])).toContain('cursor=c2');
  await vi.waitFor(() => expect(document.querySelector('.retry')).toBeNull());
});

async function longPress(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  await new Promise((r) => setTimeout(r, 560));
  el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  flushSync();
}
const sheetButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.sheet-action')].find((b) => b.textContent === label);
const guideGrid = () => document.querySelector('[data-testid="guide-grid"]');
const channelCell = (i: number) => document.querySelectorAll<HTMLElement>('a.channel')[i]!;
const viewButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.views button')];
const viewButton = (name: string) => viewButtons().find((b) => b.textContent?.trim() === name)!;
const segmentButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.segments button')];
const pressed = (buttons: HTMLButtonElement[]) => buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent?.trim());
const texts = (selector: string) => [...document.querySelectorAll(selector)].map((e) => e.textContent?.trim());
/** What's on's Now list asks the grid route about the coming minute; the grid asks about hours. */
const nowListCalls = () => guide.grid.mock.calls.filter(([p]) => p.to - p.from === 60);

test('movies and series still list posters, not the guide', async () => {
  for (const kind of ['movie', 'series']) {
    route.params = { kind, categoryId: '4' };
    net.api.mockResolvedValue(pageOf([1], null));
    app = mount(Category, { target: document.body });
    await vi.waitFor(() => expect(document.querySelector('a.cell')).toBeTruthy());
    expect(guideGrid()).toBeNull();
    expect(document.querySelector('.views')).toBeNull();
    unmount(app);
    app = undefined;
  }
  expect(guide.guideMeta).not.toHaveBeenCalled();
  expect(guide.grid).not.toHaveBeenCalled();
});

test('a live category opens its guide', async () => {
  route.params = { kind: 'live', categoryId: '4' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 2'));
  expect(guideGrid()).not.toBeNull();
  expect(guide.grid.mock.calls[0]![0]).toMatchObject({ filter: 'category:4', cursor: null });
  expect(document.querySelector('h1')?.textContent).toBe('Action');
  expect(document.querySelector('.back a')?.getAttribute('href')).toBe('/browse/live');
  expect(net.api).not.toHaveBeenCalled(); // no channel list request
});

test("Live's favourites open the favourites guide", async () => {
  route.params = { kind: 'live', categoryId: 'favourites' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalled());
  expect(guide.grid.mock.calls[0]![0]).toMatchObject({ filter: 'favourites' });
  expect(document.querySelector('h1')?.textContent).toBe('Favourites');
  expect(me.browse).not.toHaveBeenCalled();
  expect(net.api).not.toHaveBeenCalled();
});

test('a failed guide load offers Retry, which loads again', async () => {
  route.params = { kind: 'live', categoryId: '4' };
  guide.guideMeta.mockRejectedValueOnce(new Error('down'));
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('.retry')).toBeTruthy());
  expect(guideGrid()).toBeNull();
  (document.querySelector('.retry') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Ch 2'));
  expect(document.querySelector('.retry')).toBeNull();
});

test('long-pressing a guide channel: Favourite toggles, and Map guide channel opens the guide source sheet', async () => {
  route.params = { kind: 'live', categoryId: '4' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.querySelectorAll('a.channel').length).toBe(2));
  await longPress(channelCell(1));
  expect(document.querySelector('.sheet-title')?.textContent).toBe('Ch 2');
  sheetButton('Favourite')!.click();
  await vi.waitFor(() => expect(me.favourite).toHaveBeenCalledWith(2));
  await longPress(channelCell(1));
  sheetButton('Unfavourite')!.click(); // the sheet knows it is a favourite now
  await vi.waitFor(() => expect(me.unfavourite).toHaveBeenCalledWith(2));
  await longPress(channelCell(1));
  sheetButton('Map guide channel…')!.click();
  flushSync();
  expect(document.querySelector('[role="dialog"][aria-label="Map guide channel"]')).not.toBeNull();
  expect(document.querySelector('.sheet-title')?.textContent).toBe('Ch 2');
});

test('a mapped guide channel reloads the guide', async () => {
  route.params = { kind: 'live', categoryId: '4' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.querySelectorAll('a.channel').length).toBe(2));
  await longPress(channelCell(0));
  sheetButton('Map guide channel…')!.click();
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>('.result')].find((b) => b.textContent === 'Automatic matching')!.click();
  await vi.waitFor(() => expect(guide.setGuideSource).toHaveBeenCalledWith(1, null));
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(2));
  expect(document.body.textContent).toContain('Guide will update in a minute or two');
});

test("a live category offers What's on and Grid: Grid first, and What's on lists the category from Now", async () => {
  route.params = { kind: 'live', categoryId: '4' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(guideGrid()).not.toBeNull());
  expect(viewButtons().map((b) => b.textContent?.trim())).toEqual(["What's on", 'Grid']);
  expect(pressed(viewButtons())).toEqual(['Grid']); // the server's first-ever default
  expect(guide.whatsOn).not.toHaveBeenCalled();
  viewButton("What's on").click();
  flushSync();
  expect(guideGrid()).toBeNull();
  expect(pressed(viewButtons())).toEqual(["What's on"]);
  expect(segmentButtons().map((b) => b.textContent?.trim())).toEqual(['Earlier', 'Now', 'Tonight', 'Tomorrow']);
  expect(pressed(segmentButtons())).toEqual(['Now']);
  await vi.waitFor(() => expect(nowListCalls()).toHaveLength(1));
  expect(nowListCalls()[0]![0]).toMatchObject({ filter: 'category:4', cursor: null });
  // Every channel, each with what's on now underneath; a tap watches it live.
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 1', 'Ch 2']));
  expect(texts('.entry .sub')).toEqual(['No guide information', 'No guide information']);
  expect([...document.querySelectorAll('a.entry')].map((a) => a.getAttribute('href'))).toEqual(['/watch?item=1', '/watch?item=2']);
  expect(guide.whatsOn).not.toHaveBeenCalled();
  viewButton('Grid').click();
  flushSync();
  expect(guideGrid()).not.toBeNull();
  expect(document.querySelector('.segments')).toBeNull();
});

test("Live favourites' What's on lists the favourites", async () => {
  route.params = { kind: 'live', categoryId: 'favourites' };
  guide.guideMeta.mockResolvedValue(metaWith('whatson'));
  guide.grid.mockResolvedValue({ items: [], nextCursor: null });
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalled());
  expect(pressed(viewButtons())).toEqual(["What's on"]);
  expect(guide.grid).toHaveBeenCalledTimes(1); // the Now list's, with no grid
  expect(nowListCalls()[0]![0]).toMatchObject({ filter: 'favourites', cursor: null });
  expect(guideGrid()).toBeNull();
  expect(guide.whatsOn).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.body.textContent).toContain('No favourite channels yet'));
});

test('the view is saved with the guide prefs, and another category opens on it', async () => {
  // The server's prefs: what was last saved, else its default.
  let saved: GuidePrefs = { view: 'grid', filter: 'all' };
  guide.guideMeta.mockImplementation(async () => ({ ...meta, prefs: saved }));
  guide.saveGuidePrefs.mockImplementation(async (p: GuidePrefs) => void (saved = p));
  route.params = { kind: 'live', categoryId: '4' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(guideGrid()).not.toBeNull());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  viewButton("What's on").click();
  flushSync();
  expect(guide.saveGuidePrefs).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(guide.saveGuidePrefs).toHaveBeenCalledTimes(1);
  expect(guide.saveGuidePrefs).toHaveBeenCalledWith({ view: 'whatson', filter: 'all' }); // the filter goes back as it came
  vi.useRealTimers();
  unmount(app);
  route.params = { kind: 'live', categoryId: 'favourites' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(nowListCalls()).toHaveLength(2));
  expect(pressed(viewButtons())).toEqual(["What's on"]);
  expect(nowListCalls()[1]![0]).toMatchObject({ filter: 'favourites' });
  expect(guideGrid()).toBeNull();
});

test('a view still waiting to be saved is saved once on leaving the page', async () => {
  route.params = { kind: 'live', categoryId: '4' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(guideGrid()).not.toBeNull());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  viewButton("What's on").click();
  flushSync();
  unmount(app);
  app = undefined;
  expect(guide.saveGuidePrefs).toHaveBeenCalledTimes(1);
  expect(guide.saveGuidePrefs).toHaveBeenCalledWith({ view: 'whatson', filter: 'all' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(guide.saveGuidePrefs).toHaveBeenCalledTimes(1);
});

test("switching category on the page keeps the view, reloads What's on for the new category on Now, and drops the old answer", async () => {
  route.params = { kind: 'live', categoryId: '4' };
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(guideGrid()).not.toBeNull());
  guide.grid.mockResolvedValueOnce(rows(1));
  viewButton("What's on").click(); // the server still says grid when the next meta loads
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 1']));
  let resolveOld!: (p: Page<WhatsOnEntry>) => void;
  guide.whatsOn.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
  segmentButtons().find((b) => b.textContent?.trim() === 'Earlier')!.click();
  await vi.waitFor(() => expect(guide.whatsOn).toHaveBeenCalledTimes(1));
  expect(guide.whatsOn.mock.calls[0]![0]).toMatchObject({ filter: 'category:4', mode: 'past' });

  guide.grid.mockResolvedValueOnce(rows(2));
  route.params = { kind: 'live', categoryId: '5' };
  flushSync();
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 2']));
  expect(guide.guideMeta).toHaveBeenCalledTimes(2);
  expect(nowListCalls()).toHaveLength(2);
  expect(nowListCalls()[1]![0]).toMatchObject({ filter: 'category:5', cursor: null });
  expect((guide.whatsOn.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  expect(pressed(viewButtons())).toEqual(["What's on"]);
  expect(pressed(segmentButtons())).toEqual(['Now']);
  expect(guide.grid).toHaveBeenCalledTimes(3); // the grid's only load came before the switch to What's on
  resolveOld(whatsOnPage(3));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.body.textContent).not.toContain('Show 3');
  expect(texts('.entry .title')).toEqual(['Ch 2']);
});

test('switching category while the Now list loads asks about the new category and drops the old answer', async () => {
  route.params = { kind: 'live', categoryId: '4' };
  guide.guideMeta.mockResolvedValue(metaWith('whatson'));
  let resolveOld!: (p: Page<GridRow>) => void;
  guide.grid.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(1));
  expect(guide.grid.mock.calls[0]![0]).toMatchObject({ filter: 'category:4', cursor: null });
  guide.grid.mockResolvedValueOnce(rows(2));
  route.params = { kind: 'live', categoryId: '5' };
  flushSync();
  await vi.waitFor(() => expect(texts('.entry .title')).toEqual(['Ch 2']));
  expect(guide.grid).toHaveBeenCalledTimes(2);
  expect(guide.grid.mock.calls[1]![0]).toMatchObject({ filter: 'category:5', cursor: null });
  expect((guide.grid.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  resolveOld(rows(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(texts('.entry .title')).toEqual(['Ch 2']);
});

test("long-pressing a What's on row: Favourite toggles, and Map guide channel opens the guide source sheet and reloads What's on", async () => {
  route.params = { kind: 'live', categoryId: '4' };
  guide.guideMeta.mockResolvedValue(metaWith('whatson'));
  app = mount(Category, { target: document.body });
  await vi.waitFor(() => expect(document.querySelectorAll('.entry').length).toBe(2));
  const row = () => document.querySelectorAll<HTMLElement>('.entry')[1]!;
  await longPress(row());
  expect(document.querySelector('.sheet-title')?.textContent).toBe('Ch 2');
  sheetButton('Favourite')!.click();
  await vi.waitFor(() => expect(me.favourite).toHaveBeenCalledWith(2));
  await longPress(row());
  sheetButton('Unfavourite')!.click(); // the sheet knows it is a favourite now
  await vi.waitFor(() => expect(me.unfavourite).toHaveBeenCalledWith(2));
  await longPress(row());
  sheetButton('Map guide channel…')!.click();
  flushSync();
  expect(document.querySelector('[role="dialog"][aria-label="Map guide channel"]')).not.toBeNull();
  expect(document.querySelector('.sheet-title')?.textContent).toBe('Ch 2');
  [...document.querySelectorAll<HTMLButtonElement>('.result')].find((b) => b.textContent === 'Automatic matching')!.click();
  await vi.waitFor(() => expect(guide.setGuideSource).toHaveBeenCalledWith(2, null));
  await vi.waitFor(() => expect(guide.grid).toHaveBeenCalledTimes(2)); // What's on loads again with the new link
});
