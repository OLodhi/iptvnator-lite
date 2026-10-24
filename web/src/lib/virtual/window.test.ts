import { expect, test } from 'vitest';
import { visibleRange } from './window.ts';

const base = { viewport: 600, rowHeight: 50, columns: 1 };

test('top of the list renders the first rows plus overscan and no top pad', () => {
  const r = visibleRange({ ...base, scrollTop: 0, count: 1000 });
  // 600/50 = 12 visible rows + 6 overscan below
  expect(r).toEqual({ start: 0, end: 18, padTop: 0, padBottom: (1000 - 18) * 50 });
});

test('middle applies overscan on both sides', () => {
  const r = visibleRange({ ...base, scrollTop: 5000, count: 1000 });
  // first visible row 100, rows 100..111 visible (end 112 exclusive)
  expect(r.start).toBe(94);
  expect(r.end).toBe(118);
  expect(r.padTop).toBe(94 * 50);
  expect(r.padBottom).toBe((1000 - 118) * 50);
});

test('grid rows are computed per row of columns and indices are item indices', () => {
  const r = visibleRange({ viewport: 300, rowHeight: 100, columns: 3, scrollTop: 1000, count: 100, overscan: 1 });
  // rows 10..12 visible; overscan 1 -> rows 9..13
  expect(r.start).toBe(27);
  expect(r.end).toBe(42);
  expect(r.padTop).toBe(9 * 100);
  // 34 rows total (ceil(100/3)); rendered rows 9..13 = 5
  expect(r.padBottom).toBe((34 - 14) * 100);
});

test('a partial last grid row clamps end to count', () => {
  const r = visibleRange({ viewport: 300, rowHeight: 100, columns: 3, scrollTop: 100000, count: 100 });
  expect(r.end).toBe(100);
  expect(r.padBottom).toBe(0);
});

test('count 0 renders nothing', () => {
  expect(visibleRange({ ...base, scrollTop: 0, count: 0 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
});

test('viewport taller than the list renders everything', () => {
  const r = visibleRange({ viewport: 5000, rowHeight: 50, columns: 1, scrollTop: 0, count: 10 });
  expect(r).toEqual({ start: 0, end: 10, padTop: 0, padBottom: 0 });
});

test('negative scrollTop (list below the fold) behaves like the top', () => {
  const r = visibleRange({ ...base, scrollTop: -400, count: 100 });
  expect(r.start).toBe(0);
  expect(r.padTop).toBe(0);
});

test('padTop + rendered rows + padBottom equals the total height', () => {
  for (const [scrollTop, columns, count] of [[0, 1, 1000], [7777, 1, 1000], [1234, 3, 100], [99999, 4, 101], [0, 2, 1]] as const) {
    const r = visibleRange({ viewport: 640, rowHeight: 48, columns, scrollTop, count });
    const renderedRows = Math.ceil((r.end - r.start) / columns);
    expect(r.padTop + renderedRows * 48 + r.padBottom).toBe(Math.ceil(count / columns) * 48);
  }
});
