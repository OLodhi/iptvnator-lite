import { expect, test } from 'vitest';
import { formatClock, progress } from './time.ts';

const tz = 'Europe/London';
const sec = (iso: string) => Date.parse(iso) / 1000;

test('formatClock and progress clamp', () => {
  expect(formatClock(sec('2026-10-24T17:05:00Z'), tz)).toBe('18:05');
  expect(formatClock(sec('2026-10-25T00:00:00Z'), tz)).toBe('01:00');
  expect(progress(100, 200, 150_000)).toBe(0.5);
  expect(progress(100, 200, 50_000)).toBe(0);
  expect(progress(100, 200, 500_000)).toBe(1);
  expect(progress(100, 100, 100_000)).toBe(0);
});
