// The provider's wall clock, used only to format and read Xtream timeshift times.
// Everything else in the guide is UTC epoch seconds.

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

const FIXED = /^UTC(?:([+-])(\d{2}):(\d{2}))?$/;
const MAX_OFFSET_SEC = 14 * 3600;
const formatters = new Map<string, Intl.DateTimeFormat>();

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The offset of a fixed-offset (or null = UTC) zone in seconds; null for a named IANA zone. */
function fixedOffsetSec(tz: string | null): number | null {
  if (tz == null) return 0; // null or a legacy account without the key
  const m = FIXED.exec(tz);
  if (!m) return null;
  if (!m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** 'YYYY-MM-DD HH:mm:ss' read as UTC, in epoch seconds. */
function parseNaive(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)) / 1000;
}

export function resolveProviderTimezone(info: { timezone?: unknown; time_now?: unknown; timestamp_now?: unknown }): string | null {
  const named = typeof info.timezone === 'string' ? info.timezone.trim() : '';
  if (named !== '' && validZone(named)) return named;
  const now = typeof info.time_now === 'string' ? parseNaive(info.time_now) : null;
  const stamp = info.timestamp_now === null || info.timestamp_now === '' ? NaN : Number(info.timestamp_now);
  if (now === null || !Number.isFinite(stamp)) return null;
  const offset = Math.max(-MAX_OFFSET_SEC, Math.min(MAX_OFFSET_SEC, Math.round((now - stamp) / 900) * 900));
  if (offset === 0) return 'UTC';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return `UTC${offset < 0 ? '-' : '+'}${hh}:${mm}`;
}

export function wallClockParts(epochSec: number, tz: string | null): Parts {
  const fixed = fixedOffsetSec(tz);
  if (fixed !== null) {
    const d = new Date((epochSec + fixed) * 1000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
  const out: Record<string, number> = {};
  for (const p of formatter(tz as string).formatToParts(new Date(epochSec * 1000))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute! };
}

/** 'YYYY-MM-DD:HH-MM' on the provider's wall clock, the start format of Xtream timeshift URLs. */
export function formatCatchupStart(epochSec: number, tz: string | null): string {
  const w = wallClockParts(epochSec, tz);
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)}:${p(w.hour)}-${p(w.minute)}`;
}

/** 'YYYY-MM-DD HH:mm:ss' on the provider's wall clock → epoch seconds. */
export function parseProviderLocal(s: string, tz: string | null): number | null {
  const naive = parseNaive(s);
  if (naive === null) return null;
  const fixed = fixedOffsetSec(tz);
  if (fixed !== null) return naive - fixed;
  // Guess the wall time as UTC, measure how far the zone's clock lands from it, correct; twice for DST edges.
  const secs = naive % 60;
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const w = wallClockParts(guess, tz);
    guess -= Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) / 1000 + secs - naive;
  }
  return guess;
}
