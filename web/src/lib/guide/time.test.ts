import { expect, test } from 'vitest';
import { formatClock, progress, segmentQuery, zonedEpochSec } from './time.ts';

const tz = 'Europe/London';
const sec = (iso: string) => Date.parse(iso) / 1000;
const ms = (iso: string) => Date.parse(iso);

test('segment boundaries across the clock change', () => {
  expect(segmentQuery('tonight', ms('2026-10-24T10:00:00Z'), tz)).toEqual({
    mode: 'range', from: sec('2026-10-24T17:00:00Z'), to: sec('2026-10-25T02:00:00Z'),
  });
  expect(segmentQuery('tonight', ms('2026-10-25T20:00:00Z'), tz)).toEqual({
    mode: 'range', from: sec('2026-10-25T20:00:00Z'), to: sec('2026-10-26T02:00:00Z'),
  });
  expect(segmentQuery('tomorrow', ms('2026-10-24T10:00:00Z'), tz)).toEqual({
    mode: 'range', from: sec('2026-10-25T06:00:00Z'), to: sec('2026-10-26T02:00:00Z'),
  });
});

test('after midnight belongs to the previous broadcast day', () => {
  const now = ms('2026-10-21T00:00:00Z'); // 01:00 BST on the 21st
  expect(segmentQuery('tonight', now, tz)).toEqual({
    mode: 'range', from: now / 1000, to: sec('2026-10-21T01:00:00Z'), // 02:00 BST
  });
  expect(segmentQuery('tomorrow', now, tz)).toEqual({
    mode: 'range', from: sec('2026-10-21T05:00:00Z'), to: sec('2026-10-22T01:00:00Z'), // 06:00 BST on the 21st
  });
});

test('tonight is empty between 02:00 and 06:00', () => {
  expect(segmentQuery('tonight', ms('2026-10-21T03:30:00Z'), tz)).toBeNull(); // 04:30 BST
});

test('earlier is the last 24 hours in past mode', () => {
  const now = ms('2026-10-24T10:00:00Z');
  expect(segmentQuery('earlier', now, tz)).toEqual({ mode: 'past', from: now / 1000 - 86400, to: now / 1000 });
  expect(segmentQuery('now', now, tz)).toEqual({ mode: 'now' });
});

test('zonedEpochSec is deterministic around the clock changes', () => {
  // fall back: 01:30 happens twice (00:30Z in BST, 01:30Z in GMT); the later one wins
  expect(zonedEpochSec(2026, 10, 25, 1, 30, tz)).toBe(sec('2026-10-25T01:30:00Z'));
  expect(zonedEpochSec(2026, 10, 25, 2, 0, tz)).toBe(sec('2026-10-25T02:00:00Z'));
  // spring forward: 01:30 on 2026-03-29 does not exist; the result is after the change
  expect(zonedEpochSec(2026, 3, 29, 1, 30, tz)).toBe(sec('2026-03-29T01:30:00Z'));
  expect(zonedEpochSec(2026, 3, 29, 2, 30, tz)).toBe(sec('2026-03-29T01:30:00Z'));
  expect(zonedEpochSec(2026, 10, 24, 18, 0, tz)).toBe(sec('2026-10-24T17:00:00Z'));
});

test('formatClock and progress clamp', () => {
  expect(formatClock(sec('2026-10-24T17:05:00Z'), tz)).toBe('18:05');
  expect(formatClock(sec('2026-10-25T00:00:00Z'), tz)).toBe('01:00');
  expect(progress(100, 200, 150_000)).toBe(0.5);
  expect(progress(100, 200, 50_000)).toBe(0);
  expect(progress(100, 200, 500_000)).toBe(1);
  expect(progress(100, 100, 100_000)).toBe(0);
});
