import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { CatalogItem } from '@tv/shared';
import ChannelRow from './ChannelRow.svelte';

const base: CatalogItem = {
  id: 1, providerId: 1, kind: 'live', name: 'BBC One', displayName: 'BBC One', logoUrl: null,
  catchupDays: null, year: null, rating: null, favourite: false,
};
let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(150_000);
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('shows the on-now title and progress', () => {
  const item = { ...base, now: { title: 'News at Six', startSec: 100, stopSec: 200 } };
  app = mount(ChannelRow, { target: document.body, props: { item, onToggleFavourite: vi.fn() } });
  flushSync();
  expect(document.querySelector('.now-title')?.textContent).toBe('News at Six');
  expect((document.querySelector('.now-bar > span') as HTMLElement).style.width).toBe('50%');
});

test('no line without a programme', () => {
  for (const now of [undefined, null]) {
    document.body.innerHTML = '';
    const item = { ...base, now };
    const a = mount(ChannelRow, { target: document.body, props: { item, onToggleFavourite: vi.fn() } });
    flushSync();
    expect(document.querySelector('.now-title')).toBeNull();
    unmount(a);
  }
});
