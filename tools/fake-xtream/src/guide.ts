import type { FakeItem } from './catalogue.ts';

export type GuideWindow = { pastDays: number; futureDays: number; programmeMinutes: number };
export const DEFAULT_WINDOW: GuideWindow = { pastDays: 3, futureDays: 2, programmeMinutes: 60 };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TAG = /^(\w{2}\| |\|\w{2}\| )/;

/** The item name without its country or language tag: 'UK| HLS Channel' becomes 'HLS Channel'. */
export function displayName(name: string): string {
  return name.replace(TAG, '');
}

/** Wall-clock 'YYYY-MM-DD HH:mm:ss' in an IANA timezone. */
export function formatInZone(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function utc(ms: number): string {
  return new Date(ms).toISOString();
}

/** `YYYYMMDDHHmmss +0000` */
function xmltvTime(ms: number): string {
  return `${utc(ms).slice(0, 19).replace(/[-T:]/g, '')} +0000`;
}

export type Programme = { start: number; stop: number; title: string; description: string };

function gridStart(now: number, w: GuideWindow): number {
  return Math.floor((now - w.pastDays * DAY_MS) / HOUR_MS) * HOUR_MS;
}

/** Programmes every `programmeMinutes` from the hour at `now - pastDays` up to `now + futureDays`. */
function* programmes(name: string, now: number, w: GuideWindow): Generator<Programme> {
  const step = w.programmeMinutes * 60_000;
  const end = now + w.futureDays * DAY_MS;
  for (let start = gridStart(now, w); start < end; start += step) {
    const hhmm = utc(start).slice(11, 16);
    yield { start, stop: start + step, title: `${name} ${hhmm}`, description: `${name} at ${hhmm} UTC` };
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The XMLTV document as string chunks (one element each), so no caller ever holds all of it. */
export async function* xmltvChunks(items: FakeItem[], now: number, w: GuideWindow): AsyncGenerator<string> {
  const channels = items.filter((i) => i.epgChannelId);
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="fake-xtream">\n';
  for (const c of channels) {
    yield `<channel id="${escapeXml(c.epgChannelId!)}"><display-name>${escapeXml(displayName(c.name))}</display-name></channel>\n`;
  }
  yield '<channel id="other.uk"><display-name>Other Channel</display-name></channel>\n';
  for (const c of channels) {
    const name = displayName(c.name);
    const id = escapeXml(c.epgChannelId!);
    for (const p of programmes(name, now, w)) {
      yield `<programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${id}">\n<title>${escapeXml(p.title)}</title>\n<desc>${escapeXml(p.description)}</desc>\n</programme>\n`;
    }
  }
  yield '</tv>\n';
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Provider EPG listings for one live item. `fromNow` limits to the next `limit` programmes starting with the one airing now. */
export function listings(
  item: FakeItem,
  now: number,
  w: GuideWindow,
  timeZone: string,
  fromNow?: { limit: number },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const p of programmes(displayName(item.name), now, w)) {
    if (fromNow && (p.stop <= now || out.length >= fromNow.limit)) continue;
    out.push({
      id: `${item.id}-${p.start / 1000}`,
      epg_id: String(item.id),
      title: b64(p.title),
      lang: '',
      start: formatInZone(p.start, timeZone),
      end: formatInZone(p.stop, timeZone),
      description: b64(p.description),
      channel_id: item.epgChannelId,
      start_timestamp: String(p.start / 1000),
      stop_timestamp: String(p.stop / 1000),
    });
  }
  return out;
}
