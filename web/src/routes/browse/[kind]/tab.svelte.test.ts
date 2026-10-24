import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BrowseView } from '@tv/shared';

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
  recent: [], favourites: [], continueWatching: [], newCategories: 0,
});

let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
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
