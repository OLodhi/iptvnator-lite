import { expect, test } from 'vitest';
import type { Programme } from '@tv/shared';
import { PAGE_SEC, initialWindow, layoutProgrammes } from './layout.ts';

const T0 = Date.UTC(2026, 9, 24, 11, 0) / 1000; // window start
const END = T0 + PAGE_SEC;
const MIN = 60;
const prog = (id: number, startSec: number, stopSec: number): Programme => ({
  id, title: `P${id}`, subtitle: null, description: null, category: null, startSec, stopSec,
});
const at = (min: number) => T0 + min * MIN;

test('blocks clip to the window and keep a minimum width', () => {
  const blocks = layoutProgrammes(
    [
      prog(5, at(-120), at(-60)), // ends before the window
      prog(7, at(-30), at(0)), // ends exactly at the window start
      prog(1, at(-30), at(30)), // starts before the window
      prog(2, at(30), at(90)),
      prog(3, at(100), at(100) + 20), // 20 seconds: 1 px, widened to 2
      prog(4, at(330), at(400)), // runs past the window
      prog(6, at(360), at(420)), // starts at the window end
    ],
    T0,
    END,
    at(0),
  );
  expect(blocks.map((b) => [b.programme.id, b.left, b.width])).toEqual([
    [1, 0, 90],
    [2, 90, 180],
    [3, 300, 2],
    [4, 990, 90],
  ]);
});

test('classifies past, now and future', () => {
  const blocks = layoutProgrammes([prog(1, at(0), at(60)), prog(2, at(60), at(120)), prog(3, at(120), at(180))], T0, END, at(60));
  expect(blocks.map((b) => b.state)).toEqual(['past', 'now', 'future']);
  expect(layoutProgrammes([prog(4, at(0), at(90))], T0, END, at(89)).map((b) => b.state)).toEqual(['now']);
});

test('initialWindow floors to the half hour', () => {
  expect(initialWindow(Date.UTC(2026, 9, 24, 12, 10) / 1000)).toEqual({ from: T0, to: T0 + PAGE_SEC });
  expect(initialWindow(Date.UTC(2026, 9, 24, 12, 0) / 1000)).toEqual({ from: T0, to: T0 + PAGE_SEC });
  expect(initialWindow(Date.UTC(2026, 9, 24, 12, 45) / 1000).from).toBe(Date.UTC(2026, 9, 24, 11, 30) / 1000);
  expect(PAGE_SEC).toBe(6 * 3600);
});
