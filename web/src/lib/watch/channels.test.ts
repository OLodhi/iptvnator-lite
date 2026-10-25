import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CatalogItem, GridRow, Page } from '@tv/shared';

const guide = vi.hoisted(() => ({ grid: vi.fn() }));
vi.mock('$lib/guide', () => guide);

import { loadChannelOrder, neighbour } from './channels.ts';

const NOW_SEC = 1_800_000_000;
const row = (id: number): GridRow => ({ item: { id } as CatalogItem, programmes: [], hasGuide: false });
const page = (ids: number[], nextCursor: string | null): Page<GridRow> => ({ items: ids.map(row), nextCursor });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_SEC * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  guide.grid.mockReset();
});

test('order spans pages', async () => {
  guide.grid.mockResolvedValueOnce(page([9, 4, 7], '3')).mockResolvedValueOnce(page([2, 12], '5')).mockResolvedValueOnce(page([1], null));
  const signal = new AbortController().signal;
  expect(await loadChannelOrder('category:3', signal)).toEqual([9, 4, 7, 2, 12, 1]);
  expect(guide.grid.mock.calls).toEqual([
    [{ filter: 'category:3', from: NOW_SEC, to: NOW_SEC + 60, cursor: null, limit: 100 }, signal],
    [{ filter: 'category:3', from: NOW_SEC, to: NOW_SEC + 60, cursor: '3', limit: 100 }, signal],
    [{ filter: 'category:3', from: NOW_SEC, to: NOW_SEC + 60, cursor: '5', limit: 100 }, signal],
  ]);
});

test('neighbour stops at the ends', () => {
  const ids = [9, 4, 7];
  expect(neighbour(ids, 4, 1)).toBe(7);
  expect(neighbour(ids, 4, -1)).toBe(9);
  expect(neighbour(ids, 7, 1)).toBeNull();
  expect(neighbour(ids, 9, -1)).toBeNull();
  expect(neighbour(ids, 5, 1)).toBeNull(); // not in the list
  expect(neighbour([], 5, -1)).toBeNull();
});
