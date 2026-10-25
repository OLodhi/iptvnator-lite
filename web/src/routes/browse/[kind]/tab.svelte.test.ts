import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BrowseView, CatalogItem, Kind } from '@tv/shared';

const route = vi.hoisted(() => ({ params: { kind: 'live' } as Record<string, string> }));
const me = vi.hoisted(() => ({
  browse: vi.fn(),
  pin: vi.fn(),
  unpin: vi.fn(),
  hideCategory: vi.fn(),
}));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$lib/me', () => me);

import Tab from './+page.svelte';

const cat = (id: number, pinned = false) => ({ id, displayName: `Cat ${id}`, itemCount: 3, pinned });
const view = (): BrowseView => ({
  providerId: 1, kind: 'live', categories: [cat(1), cat(2, true)], pinned: [cat(2, true)],
  recent: [], favourites: [], favouriteCount: 0, continueWatching: [], newCategories: 0,
});
const item = (id: number, kind: Kind = 'live'): CatalogItem => ({
  id, providerId: 1, kind, name: `i${id}`, displayName: `Item ${id}`, logoUrl: null, catchupDays: null, year: null, rating: null, favourite: true,
});

let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  route.params = { kind: 'live' };
  me.browse.mockReset().mockImplementation(async () => view());
  me.pin.mockReset().mockResolvedValue(undefined);
  me.unpin.mockReset().mockResolvedValue(undefined);
  me.hideCategory.mockReset().mockResolvedValue(undefined);
  app = mount(Tab, { target: document.body });
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

const rowFor = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('a.row')].find((a) => a.textContent?.includes(name))!;

async function longPress(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  await new Promise((r) => setTimeout(r, 560));
  flushSync();
}
const sheetButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.sheet-action')].find((b) => b.textContent === label)!;

test('long-press then Pin pins the pressed category', async () => {
  await vi.waitFor(() => expect(rowFor('Cat 1')).toBeTruthy());
  await longPress(rowFor('Cat 1'));
  sheetButton('Pin').click();
  await vi.waitFor(() => expect(me.pin).toHaveBeenCalledWith(1));
});

test('long-press then Unpin and Hide use the pressed category', async () => {
  await vi.waitFor(() => expect(rowFor('Cat 2')).toBeTruthy());
  await longPress(rowFor('Cat 2'));
  sheetButton('Unpin').click();
  await vi.waitFor(() => expect(me.unpin).toHaveBeenCalledWith(2));
  await longPress(rowFor('Cat 2'));
  sheetButton('Hide').click();
  await vi.waitFor(() => expect(me.hideCategory).toHaveBeenCalledWith(2));
});

test('a failed action still shows its error after the reload', async () => {
  await vi.waitFor(() => expect(rowFor('Cat 1')).toBeTruthy());
  me.pin.mockRejectedValueOnce(new Error('boom'));
  await longPress(rowFor('Cat 1'));
  sheetButton('Pin').click();
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/went wrong/));
  expect(me.browse.mock.calls.length).toBeGreaterThanOrEqual(2); // reloaded as well
});

async function showing(v: BrowseView) {
  if (app) unmount(app);
  me.browse.mockReset().mockImplementation(async () => v);
  app = mount(Tab, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('a.row')).toBeTruthy());
}
const favouritesLink = () => document.querySelector<HTMLAnchorElement>('a[href="/browse/live/favourites"]');

test('Live leads Pinned with a Favourites row and its count, which opens the favourites guide', async () => {
  await showing({ ...view(), favourites: [item(6)], favouriteCount: 12 });
  const rows = [...document.querySelectorAll<HTMLAnchorElement>('a.row')];
  expect(rows[0]).toBe(favouritesLink());
  expect(rows[0]!.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/^★ ?Favourites 12 ›$/);
  expect(rows[0]!.closest('ul')?.previousElementSibling?.textContent).toBe('Pinned');
  expect(rows[1]!.textContent).toContain('Cat 2'); // then the pinned categories
});

test('no Favourites row without live favourites', async () => {
  await vi.waitFor(() => expect(rowFor('Cat 1')).toBeTruthy());
  expect(favouritesLink()).toBeNull();
});

test('on Live the favourites carousel is gone and Recently watched remains', async () => {
  await showing({ ...view(), recent: [item(5)], favourites: [item(6)], favouriteCount: 1 });
  expect(document.querySelector('section[aria-label="Recently watched"]')?.textContent).toContain('Item 5');
  expect(document.querySelectorAll('section.carousel')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Item 6');
});

test('Movies keep their favourites carousel and get no Favourites row', async () => {
  route.params = { kind: 'movie' };
  await showing({ ...view(), kind: 'movie', favourites: [item(7, 'movie')], favouriteCount: 1 });
  expect(document.querySelector('section[aria-label="Favourites"]')?.textContent).toContain('Item 7');
  expect(favouritesLink()).toBeNull();
});
