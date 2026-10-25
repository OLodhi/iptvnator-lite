import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, GridRow, GuideMeta, Page } from '@tv/shared';

const route = vi.hoisted(() => ({ params: { kind: 'movie', categoryId: '4' } as Record<string, string> }));
const me = vi.hoisted(() => ({ browse: vi.fn(), favourite: vi.fn(), unfavourite: vi.fn() }));
const net = vi.hoisted(() => ({ api: vi.fn() }));
const guide = vi.hoisted(() => ({ guideMeta: vi.fn(), grid: vi.fn(), programmes: vi.fn(), guideSources: vi.fn(), setGuideSource: vi.fn() }));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$lib/me', () => me);
vi.mock('$lib/api', async (orig) => ({ ...(await orig<typeof import('$lib/api')>()), api: net.api }));
vi.mock('$lib/guide', () => guide);

import Category from './+page.svelte';
import { rememberCategories } from '$lib/categoryNames';

const item = (id: number, kind: CatalogItem['kind'] = 'movie'): CatalogItem => ({
  id, providerId: 1, kind, name: `m${id}`, displayName: `Movie ${id}`, logoUrl: null,
  catchupDays: null, year: null, rating: null, favourite: false,
});
const pageOf = (ids: number[], nextCursor: string | null): Page<CatalogItem> => ({ items: ids.map((id) => item(id)), nextCursor });
const channel = (id: number): CatalogItem => ({ ...item(id, 'live'), name: `UK| Ch ${id}`, displayName: `Ch ${id}` });
const rows = (...ids: number[]): Page<GridRow> => ({ items: ids.map((id) => ({ item: channel(id), programmes: [], hasGuide: false })), nextCursor: null });
const meta: GuideMeta = { providerId: 1, chips: [], prefs: { view: 'grid', filter: 'all' }, range: null, status: null };

let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  route.params = { kind: 'movie', categoryId: '4' };
  me.browse.mockReset().mockResolvedValue({ categories: [], pinned: [] });
  me.favourite.mockReset().mockResolvedValue(undefined);
  me.unfavourite.mockReset().mockResolvedValue(undefined);
  net.api.mockReset();
  guide.guideMeta.mockReset().mockResolvedValue(meta);
  guide.grid.mockReset().mockResolvedValue(rows(1, 2));
  guide.programmes.mockReset().mockResolvedValue({});
  guide.guideSources.mockReset().mockResolvedValue([]);
  guide.setGuideSource.mockReset().mockResolvedValue(undefined);
  rememberCategories({ categories: [{ id: 4, displayName: 'Action', itemCount: 2, pinned: false }], pinned: [] } as never);
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
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

test('movies and series still list posters, not the guide', async () => {
  for (const kind of ['movie', 'series']) {
    route.params = { kind, categoryId: '4' };
    net.api.mockResolvedValue(pageOf([1], null));
    app = mount(Category, { target: document.body });
    await vi.waitFor(() => expect(document.querySelector('a.cell')).toBeTruthy());
    expect(guideGrid()).toBeNull();
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
