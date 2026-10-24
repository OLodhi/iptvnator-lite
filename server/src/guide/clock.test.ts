import { expect, test } from 'vitest';
import { formatCatchupStart, parseProviderLocal, resolveProviderTimezone, wallClockParts } from './clock.ts';

const sec = (...a: Parameters<typeof Date.UTC>) => Date.UTC(...a) / 1000;

test('formats the catch-up start in summer and winter', () => {
  expect(formatCatchupStart(sec(2026, 6, 1, 18, 0), 'Europe/London')).toBe('2026-07-01:19-00');
  expect(formatCatchupStart(sec(2026, 0, 15, 18, 0), 'Europe/London')).toBe('2026-01-15:18-00');
});

test('fixed offsets', () => {
  expect(wallClockParts(sec(2026, 0, 15, 18, 0), 'UTC+05:30')).toEqual({ year: 2026, month: 1, day: 15, hour: 23, minute: 30 });
  expect(wallClockParts(sec(2026, 0, 15, 18, 0), 'UTC-03:00').hour).toBe(15);
  expect(wallClockParts(sec(2026, 0, 15, 18, 0), null).hour).toBe(18);
  expect(formatCatchupStart(sec(2026, 0, 15, 18, 0), null)).toBe('2026-01-15:18-00');
});

test('resolveProviderTimezone', () => {
  const at = sec(2026, 9, 24, 20, 30);
  expect(resolveProviderTimezone({ timezone: 'Europe/Amsterdam' })).toBe('Europe/Amsterdam');
  expect(resolveProviderTimezone({ timezone: 'Not/AZone', time_now: '2026-10-24 21:30:00', timestamp_now: at })).toBe('UTC+01:00');
  expect(resolveProviderTimezone({ time_now: '2026-10-24 21:30:00', timestamp_now: String(at) })).toBe('UTC+01:00');
  // 77 minutes ahead snaps to the nearest 15 minutes.
  expect(resolveProviderTimezone({ time_now: '2026-10-24 21:47:00', timestamp_now: at })).toBe('UTC+01:15');
  expect(resolveProviderTimezone({ time_now: '2026-10-24 20:30:00', timestamp_now: at })).toBe('UTC');
  expect(resolveProviderTimezone({ time_now: '2026-10-25 11:30:00', timestamp_now: at })).toBe('UTC+14:00');
  expect(resolveProviderTimezone({})).toBeNull();
});

test('parseProviderLocal reads wall time in the zone', () => {
  expect(parseProviderLocal('2026-07-01 19:00:00', 'Europe/London')).toBe(sec(2026, 6, 1, 18, 0));
  expect(parseProviderLocal('2026-01-15 19:00:00', 'Europe/London')).toBe(sec(2026, 0, 15, 19, 0));
  expect(parseProviderLocal('2026-01-15 19:00:00', 'UTC+05:30')).toBe(sec(2026, 0, 15, 13, 30));
  expect(parseProviderLocal('2026-01-15 19:00:00', null)).toBe(sec(2026, 0, 15, 19, 0));
  expect(parseProviderLocal('garbage', null)).toBeNull();
});
