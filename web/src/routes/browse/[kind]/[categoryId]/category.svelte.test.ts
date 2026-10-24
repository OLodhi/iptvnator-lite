import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem, Page } from '@tv/shared';

const route = vi.hoisted(() => ({ params: { kind: 'movie', categoryId: '4' } as Record<string, string> }));
const me = vi.hoisted(() => ({ browse: vi.fn(), favourite: vi.fn(), unfavourite: vi.fn() }));
const net = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$lib/me', () => me);
vi.mock('$lib/api', async (orig) => ({ ...(await orig<typeof import('$lib/api')>()), api: net.api }));

import Category from './+page.svelte';
import { rememberCategories } from '$lib/categoryNames';

const item = (id: number): CatalogItem => ({
  id, providerId: 1, kind: 'movie', name: `m${id}`, displayName: `Movie ${id}`, logoUrl: null,
  catchupDays: null, year: null, rating: null, favourite: false,
});
const pageOf = (ids: number[], nextCursor: string | null): Page<CatalogItem> => ({ items: ids.map(item), nextCursor });

let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  route.params = { kind: 'movie', categoryId: '4' };
  me.browse.mockReset().mockResolvedValue({ categories: [], pinned: [] });
  me.favourite.mockReset().mockResolvedValue(undefined);
  me.unfavourite.mockReset().mockResolvedValue(undefined);
  net.api.mockReset();
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
