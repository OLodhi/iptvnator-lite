import { createSubscriber } from 'svelte/reactivity';

export type Segment = 'earlier' | 'now' | 'tonight' | 'tomorrow';
export type SegmentQuery = { mode: 'now' } | { mode: 'range' | 'past'; from: number; to: number };

const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOUR = 3600;

type Wall = { y: number; m: number; d: number; h: number; min: number };

function wallParts(sec: number, tz: string): Wall {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(sec * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** Epoch seconds of the local wall time `y-m-d h:min` in `tz`; a repeated hour resolves to its second occurrence. */
export function zonedEpochSec(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const wallAsUtc = Date.UTC(y, m - 1, d, h, min) / 1000;
  let utc = wallAsUtc;
  for (let i = 0; i < 3; i++) {
    const w = wallParts(utc, tz);
    const offset = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) / 1000 - utc;
    const next = wallAsUtc - offset;
    if (next === utc) break;
    utc = next;
  }
  return utc;
}

/** Calendar date `days` after y-m-d (Date.UTC normalises month and year overflow). */
function addDays(y: number, m: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** The guide query for a segment; the broadcast day starts at 06:00 local. null = nothing to show. */
export function segmentQuery(segment: Segment, nowMs: number, tz: string = deviceZone()): SegmentQuery | null {
  const now = Math.floor(nowMs / 1000);
  if (segment === 'now') return { mode: 'now' };
  if (segment === 'earlier') return { mode: 'past', from: now - 24 * HOUR, to: now };
  const base = wallParts(now - 6 * HOUR, tz);
  const at = (days: number, h: number) => {
    const day = addDays(base.y, base.m, base.d, days);
    return zonedEpochSec(day.y, day.m, day.d, h, 0, tz);
  };
  if (segment === 'tonight') {
    const from = Math.max(now, at(0, 18));
    const to = at(1, 2);
    return from < to ? { mode: 'range', from, to } : null;
  }
  return { mode: 'range', from: at(1, 6), to: at(2, 2) };
}

export function formatClock(sec: number, tz: string = deviceZone()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(sec * 1000));
}

export function progress(startSec: number, stopSec: number, nowMs: number): number {
  if (stopSec <= startSec) return 0;
  return Math.min(1, Math.max(0, (nowMs / 1000 - startSec) / (stopSec - startSec)));
}

/** A reactive clock: `nowMs` re-evaluates every `intervalMs`, and only ticks while something reads it. */
export function createClock(intervalMs = 30_000): { readonly nowMs: number; stop(): void } {
  let stopped = false;
  const subscribe = createSubscriber((update) => {
    const id = setInterval(() => !stopped && update(), intervalMs);
    return () => clearInterval(id);
  });
  return {
    get nowMs() {
      subscribe();
      return Date.now();
    },
    stop() {
      stopped = true;
    },
  };
}

let shared: ReturnType<typeof createClock> | undefined;
/** One 30 s clock for every row, started on first read, so a long list does not run thousands of timers. */
export const sharedClock = () => (shared ??= createClock());
