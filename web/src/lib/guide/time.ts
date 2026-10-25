import { createSubscriber } from 'svelte/reactivity';

// One formatter per zone ('' = the device zone): building one costs far more than formatting, and the grid formats hundreds per render.
const clockFormats = new Map<string, Intl.DateTimeFormat>();

export function formatClock(sec: number, tz?: string): string {
  let format = clockFormats.get(tz ?? '');
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    clockFormats.set(tz ?? '', format);
  }
  return format.format(new Date(sec * 1000));
}

export function progress(startSec: number, stopSec: number, nowMs: number): number {
  if (stopSec <= startSec) return 0;
  return Math.min(1, Math.max(0, (nowMs / 1000 - startSec) / (stopSec - startSec)));
}

/** A reactive clock: `nowMs` re-evaluates every `intervalMs`, and only ticks while something reads it. */
export function createClock(intervalMs = 30_000): { readonly nowMs: number; stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const subscribe = createSubscriber((update) => {
    if (!stopped) timer = setInterval(update, intervalMs);
    return () => {
      clearInterval(timer);
      timer = undefined;
    };
  });
  return {
    get nowMs() {
      subscribe();
      return Date.now();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
    },
  };
}

let shared: ReturnType<typeof createClock> | undefined;
/** One 30 s clock for every row, started on first read, so a long list does not run thousands of timers. */
export const sharedClock = () => (shared ??= createClock());
