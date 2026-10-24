import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from '../db/db.ts';
import type { XtreamClient } from '../providers/xtream/client.ts';
import type { Listing } from '../providers/xtream/normalise.ts';
import { silentLog } from '../util/log.ts';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';
import { computeLinks, loadManualMaps, loadMatchItems, relinkGuide } from './match.ts';
import type { MatchItem } from './match.ts';
import type { GuideChannelRow, GuideStore, ProgrammeRow } from './store.ts';
import { maybeGunzip, parseXmltv } from './xmltv.ts';

export type GuideRefreshResult = {
  source: 'xmltv' | 'provider';
  channels: number;
  programmes: number;
  skipped: number;
  linked: number;
  durationMs: number;
};

export class GuideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuideError';
  }
}

/** Programmes starting this far ahead or more are not stored. */
export const GUIDE_FUTURE_SEC = 8 * 86_400;

const DAY_SEC = 86_400;
const CHANNEL_BATCH = 500;
const PROGRAMME_BATCH = 2000;

type Deps = {
  db: Db;
  store: GuideStore;
  client: XtreamClient;
  providerId: number;
  /** The provider's timezone, for listings that carry only wall-clock times. */
  timezone: string | null;
  /** In browse order; used only by the fallback. */
  visibleLiveItemIds: () => number[];
  now?: () => number;
  log?: Log;
  signal?: AbortSignal;
  xmltvIdleTimeoutMs?: number;
  fallbackConcurrency?: number;
  fallbackGapMs?: number;
  fallbackMaxChannels?: number;
};
type Counts = { channels: number; programmes: number; skipped: number };
/** Wanted channel keys, exact and lower-cased, each with how far back (seconds) its programmes are kept. */
type Wanted = { exact: Map<string, number>; lower: Map<string, number> };

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const errorText = (e: unknown): string => redactUrl(e instanceof Error ? e.message : String(e));
/** A channel keeps a day of past programmes, or its catch-up days if longer. */
const pastWindowSec = (catchupDays: number | null | undefined): number => Math.max(1, catchupDays ?? 0) * DAY_SEC;

/**
 * Fetches the guide into a new generation and makes it current only once it is complete: XMLTV first, then the
 * provider's per-channel listings. On failure the generation is abandoned and the current guide is untouched.
 */
export async function refreshGuide(deps: Deps): Promise<GuideRefreshResult> {
  const { db, store, providerId, signal } = deps;
  const log = deps.log ?? silentLog;
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  const startedAt = performance.now();

  let source: GuideRefreshResult['source'] = 'xmltv';
  let generation = store.beginGeneration(providerId, nowSec);
  let counts: Counts;
  try {
    counts = await ingestXmltv(deps, generation, nowSec);
    if (counts.programmes === 0) throw new GuideError('The XMLTV guide had no programmes for these channels');
  } catch (e) {
    await store.abandonGeneration(providerId, generation);
    // The caller stopped us: not a provider failure, so no fallback and no failure recorded.
    signal?.throwIfAborted();
    log.warn({ providerId, error: errorText(e) }, 'XMLTV guide failed; trying the provider EPG');
    source = 'provider';
    generation = store.beginGeneration(providerId, nowSec);
    try {
      counts = await ingestProvider(deps, generation, nowSec);
    } catch (e2) {
      await store.abandonGeneration(providerId, generation);
      signal?.throwIfAborted();
      store.recordFailure(providerId, errorText(e2));
      throw e2;
    }
  }

  store.commitGeneration(providerId, generation, { fetchedAt: nowSec, source });
  const { linked } = relinkGuide(db, providerId);
  try {
    await store.pruneGenerations(providerId);
  } catch (e) {
    // The new guide is committed and linked; leftovers are pruned next time.
    log.warn({ providerId, error: errorText(e) }, 'pruning old guide generations failed');
  }
  const durationMs = Math.round(performance.now() - startedAt);
  log.info({ providerId, source, channels: counts.channels, programmes: counts.programmes, linked, durationMs }, 'guide refreshed');
  return { source, ...counts, linked, durationMs };
}

const inWindow = (start: number, stop: number, pastSec: number, nowSec: number): boolean =>
  stop > nowSec - pastSec && start < nowSec + GUIDE_FUTURE_SEC;

/** Buffers one generation's rows and writes them in batches, yielding to the event loop after each programme batch. */
function createWriter(store: GuideStore, providerId: number, generation: number, signal: AbortSignal | undefined) {
  let channels: GuideChannelRow[] = [];
  let programmes: ProgrammeRow[] = [];
  const written = { channels: 0, programmes: 0 };

  const flushChannels = () => {
    if (channels.length === 0) return;
    store.insertChannels(providerId, generation, channels);
    written.channels += channels.length;
    channels = [];
  };
  const flushProgrammes = async () => {
    signal?.throwIfAborted();
    const batch = programmes;
    programmes = [];
    if (batch.length > 0) written.programmes += store.insertProgrammes(providerId, generation, batch);
    await yieldToEventLoop();
  };

  return {
    written,
    channel(row: GuideChannelRow): void {
      channels.push(row);
      if (channels.length >= CHANNEL_BATCH) flushChannels();
    },
    /** Returns a promise only when a batch was written, so most calls cost no await. */
    programme(row: ProgrammeRow): Promise<void> | undefined {
      programmes.push(row);
      return programmes.length >= PROGRAMME_BATCH ? flushProgrammes() : undefined;
    },
    async flush(): Promise<void> {
      flushChannels();
      await flushProgrammes();
    },
  };
}

/** Catch-up days of the provider's live items that have any, by item id. */
function loadCatchupDays(db: Db, providerId: number): Map<number, number> {
  const rows = db
    .prepare("SELECT id, catchup_days AS days FROM items WHERE provider_id = ? AND kind = 'live' AND catchup_days > 0")
    .all(providerId) as { id: number; days: number }[];
  return new Map(rows.map((r) => [r.id, r.days]));
}

/** The keys live items link to among `channels`, plus every item's own guide id. */
function wantedKeys(
  items: MatchItem[],
  channels: { key: string; names: string[] }[],
  manual: Map<string, string>,
  catchup: Map<number, number>,
): Wanted {
  const days = new Map<string, number>();
  const want = (key: string, itemId: number) => days.set(key, Math.max(days.get(key) ?? 1, catchup.get(itemId) ?? 0));
  for (const [itemId, link] of computeLinks({ items, channels, manual })) want(link.key, itemId);
  for (const item of items) if (item.epgChannelId) want(item.epgChannelId, item.id);

  const exact = new Map<string, number>();
  const lower = new Map<string, number>();
  for (const [key, d] of days) {
    exact.set(key, d * DAY_SEC);
    const k = key.toLowerCase();
    lower.set(k, Math.max(lower.get(k) ?? 0, d * DAY_SEC));
  }
  return { exact, lower };
}

/**
 * Streams xmltv.php. Every channel is stored; programmes only for wanted channels and inside the window. The wanted
 * keys are fixed at the first programme: XMLTV lists its channels first, so a channel seen later adds nothing.
 */
async function ingestXmltv(deps: Deps, generation: number, nowSec: number): Promise<Counts> {
  const { db, providerId, signal } = deps;
  const items = loadMatchItems(db, providerId);
  const manual = loadManualMaps(db, providerId);
  const catchup = loadCatchupDays(db, providerId);
  const writer = createWriter(deps.store, providerId, generation, signal);
  const seen: GuideChannelRow[] = [];
  let wanted: Wanted | null = null;
  let dropped = 0;

  const source = maybeGunzip(await deps.client.xmltv({ signal, idleTimeoutMs: deps.xmltvIdleTimeoutMs }));
  const parsed = await parseXmltv(source, {
    channel(c) {
      signal?.throwIfAborted();
      const row = { key: c.id, name: c.names[0] ?? c.id, names: c.names };
      if (!wanted) seen.push(row);
      writer.channel(row);
    },
    programme(p) {
      signal?.throwIfAborted();
      wanted ??= wantedKeys(items, seen, manual, catchup);
      const pastSec = wanted.exact.get(p.channel) ?? wanted.lower.get(p.channel.toLowerCase());
      if (pastSec === undefined || !inWindow(p.start, p.stop, pastSec, nowSec)) {
        dropped++;
        return;
      }
      return writer.programme({
        channelKey: p.channel, start: p.start, stop: p.stop, title: p.title,
        subtitle: p.subtitle, description: p.description, category: p.category,
      });
    },
  });
  await writer.flush();
  return { ...writer.written, skipped: parsed.skipped + dropped };
}

/**
 * The provider's per-channel listings for the first visible live items, stored as `stream:<remoteId>` channels.
 * Workers share one queue; each waits `fallbackGapMs` between its own requests. A channel whose request fails
 * simply has no listings.
 */
async function ingestProvider(deps: Deps, generation: number, nowSec: number): Promise<Counts> {
  const { db, client, providerId, signal } = deps;
  const gapMs = deps.fallbackGapMs ?? 200;
  const select = db.prepare(
    "SELECT remote_id AS remoteId, name, catchup_days AS catchupDays FROM items WHERE id = ? AND provider_id = ? AND kind = 'live'",
  );
  const queue = deps
    .visibleLiveItemIds()
    .slice(0, deps.fallbackMaxChannels ?? 3000)
    .map((id) => select.get(id, providerId) as { remoteId: string; name: string; catchupDays: number | null } | undefined)
    .filter((c) => c !== undefined);
  const writer = createWriter(deps.store, providerId, generation, signal);
  let dropped = 0;
  let next = 0;
  let failed = false;

  const worker = async () => {
    for (let first = true; !failed; first = false) {
      const item = queue[next++];
      if (!item) return;
      if (!first && gapMs > 0) await delay(gapMs, undefined, { signal });
      signal?.throwIfAborted();
      let listings: Listing[];
      try {
        listings = await client.epgTable(item.remoteId, { signal, tz: deps.timezone });
      } catch {
        signal?.throwIfAborted();
        continue;
      }
      const pastSec = pastWindowSec(item.catchupDays);
      const kept = listings.filter((l) => inWindow(l.start, l.stop, pastSec, nowSec));
      dropped += listings.length - kept.length;
      if (kept.length === 0) continue;
      const key = `stream:${item.remoteId}`;
      writer.channel({ key, name: item.name, names: [item.name] });
      for (const l of kept) {
        const batch = writer.programme({
          channelKey: key, start: l.start, stop: l.stop, title: l.title,
          subtitle: null, description: l.description, category: null,
        });
        if (batch) await batch;
      }
    }
  };
  // Wait for every worker before failing, so none writes into a generation that is being abandoned.
  const results = await Promise.allSettled(
    Array.from({ length: Math.max(1, deps.fallbackConcurrency ?? 2) }, () =>
      worker().catch((e: unknown) => {
        failed = true;
        throw e;
      }),
    ),
  );
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  await writer.flush();
  if (writer.written.programmes === 0) throw new GuideError('No guide data from the provider');
  return { ...writer.written, skipped: dropped };
}
