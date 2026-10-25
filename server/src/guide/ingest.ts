import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from '../db/db.ts';
import { ProviderError } from '../providers/errors.ts';
import type { XtreamClient } from '../providers/xtream/client.ts';
import type { Listing } from '../providers/xtream/normalise.ts';
import { silentLog } from '../util/log.ts';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';
import { applyLinks, linkCandidates, loadManualMaps, loadMatchItems, planLinks, prepareNames } from './match.ts';
import type { MatchItem, NameCache } from './match.ts';
import type { GuideChannelRow, GuideStore, ProgrammeRow } from './store.ts';
import { maybeGunzip, parseXmltv } from './xmltv.ts';
import type { XmltvProgramme } from './xmltv.ts';

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
/** Rows per write. A yield from I/O resumes before timers and requests, so two batches can run back to back. */
const PROGRAMME_BATCH = 1000;
/** The fallback gives up after this many failed channels in a row while none has answered yet. */
const FALLBACK_BREAKER = 10;

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
const isAuthFailure = (e: unknown): boolean => e instanceof ProviderError && e.code === 'PROVIDER_AUTH_FAILED';
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
  // Filled while the XMLTV is read, so matching for the links before the commit normalises nothing.
  const names: NameCache = new Map();
  try {
    counts = await ingestXmltv(deps, generation, nowSec, names);
    if (counts.programmes === 0) throw new GuideError('The XMLTV guide had no programmes for these channels');
  } catch (xmltvError) {
    await store.abandonGeneration(providerId, generation);
    // The caller stopped us: not a provider failure, so no fallback and no failure recorded.
    signal?.throwIfAborted();
    if (isAuthFailure(xmltvError)) {
      // The fallback would send the same credentials.
      store.recordFailure(providerId, errorText(xmltvError), nowSec);
      throw xmltvError;
    }
    log.warn({ providerId, error: errorText(xmltvError) }, 'XMLTV guide failed; trying the provider EPG');
    source = 'provider';
    generation = store.beginGeneration(providerId, nowSec);
    try {
      counts = await ingestProvider(deps, generation, nowSec);
    } catch (fallbackError) {
      await store.abandonGeneration(providerId, generation);
      signal?.throwIfAborted();
      store.recordFailure(providerId, `XMLTV: ${errorText(xmltvError)}; provider EPG: ${errorText(fallbackError)}`, nowSec);
      throw fallbackError;
    }
  }

  // One transaction (the links' own nests as a savepoint): readers never see the new guide with the old links. The
  // matching runs before it, so it only writes.
  let linked: number;
  try {
    const plan = await planLinks(db, providerId, generation, source, names, nowSec);
    ({ linked } = db.transaction(() => {
      // The links first: checking that the plan is fresh must not see the commit's own write.
      const result = applyLinks(db, providerId, plan, names);
      store.commitGeneration(providerId, generation, { fetchedAt: nowSec, source });
      return result;
    })());
  } catch (e) {
    // Nothing was committed, so the generation is still above the current one and abandoning it proceeds.
    await store.abandonGeneration(providerId, generation);
    store.recordFailure(providerId, errorText(e), nowSec);
    throw e;
  }
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

/**
 * Every key a live item could link to among `channels`, plus every item's own guide id. Which candidate an item
 * links to depends on which have listings, so all of them are wanted; each keeps the catch-up days of every item
 * that could link to it. They are all declared channels, so at most the whole guide is wanted.
 */
function wantedKeys(
  items: MatchItem[],
  channels: { key: string; names: string[] }[],
  manual: Map<string, string>,
  catchup: Map<number, number>,
  names: NameCache,
): Wanted {
  const days = new Map<string, number>();
  const want = (key: string, itemId: number) => days.set(key, Math.max(days.get(key) ?? 1, catchup.get(itemId) ?? 0));
  for (const [itemId, keys] of linkCandidates({ items, channels, manual, names })) for (const key of keys) want(key, itemId);
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
 * Matching for them first normalises every name into `names`, in slices that yield to the event loop.
 */
async function ingestXmltv(deps: Deps, generation: number, nowSec: number, names: NameCache): Promise<Counts> {
  const { db, providerId, signal } = deps;
  const items = loadMatchItems(db, providerId);
  const manual = loadManualMaps(db, providerId);
  const catchup = loadCatchupDays(db, providerId);
  const writer = createWriter(deps.store, providerId, generation, signal);
  // The channels for matching, until the first programme fixes the wanted keys.
  let seen: GuideChannelRow[] | null = [];
  let wanted: Wanted = { exact: new Map(), lower: new Map() };
  // Declared channel ids, exact and by lower case (smallest on ties), so a programme whose channel attribute
  // differs from its channel's id only in case is stored under that id, where relinking will point.
  const declared = new Set<string>();
  const declaredByLower = new Map<string, string>();
  let dropped = 0;

  const take = (p: XmltvProgramme): Promise<void> | undefined => {
    const lower = p.channel.toLowerCase();
    const pastSec = wanted.exact.get(p.channel) ?? wanted.lower.get(lower);
    if (pastSec === undefined || !inWindow(p.start, p.stop, pastSec, nowSec)) {
      dropped++;
      return;
    }
    const channelKey = declared.has(p.channel) ? p.channel : (declaredByLower.get(lower) ?? p.channel);
    return writer.programme({
      channelKey, start: p.start, stop: p.stop, title: p.title,
      subtitle: p.subtitle, description: p.description, category: p.category,
    });
  };

  const source = maybeGunzip(await deps.client.xmltv({ signal, idleTimeoutMs: deps.xmltvIdleTimeoutMs }));
  const parsed = await parseXmltv(source, {
    channel(c) {
      signal?.throwIfAborted();
      const row = { key: c.id, name: c.names[0] ?? c.id, names: c.names };
      seen?.push(row);
      declared.add(c.id);
      const lower = c.id.toLowerCase();
      const prior = declaredByLower.get(lower);
      if (prior === undefined || c.id < prior) declaredByLower.set(lower, c.id);
      writer.channel(row);
    },
    programme(p) {
      signal?.throwIfAborted();
      if (!seen) return take(p);
      const channels = seen;
      seen = null;
      return prepareNames(items, channels, names).then(() => {
        wanted = wantedKeys(items, channels, manual, catchup, names);
        return take(p);
      });
    },
  });
  await writer.flush();
  return { ...writer.written, skipped: parsed.skipped + dropped };
}

/**
 * The provider's per-channel listings for the first visible live items, stored as `stream:<remoteId>` channels.
 * Workers share one queue; each waits `fallbackGapMs` between its own requests. A channel whose request fails
 * simply has no listings, except that an auth failure stops everything, and so do `FALLBACK_BREAKER` failures
 * before any channel has answered.
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
  let answered = false;
  let unanswered = 0;
  let failed = false;
  let failure: unknown;

  const worker = async () => {
    for (let first = true; !failed; first = false) {
      const item = queue[next++];
      if (!item) return;
      if (!first && gapMs > 0) await delay(gapMs, undefined, { signal });
      signal?.throwIfAborted();
      // Another worker may have failed the refresh during the gap.
      if (failed) return;
      let listings: Listing[];
      try {
        listings = await client.epgTable(item.remoteId, { signal, tz: deps.timezone });
      } catch (e) {
        signal?.throwIfAborted();
        if (isAuthFailure(e)) throw e;
        if (!answered && ++unanswered >= FALLBACK_BREAKER) {
          throw new ProviderError('PROVIDER_UNREACHABLE', `The provider EPG failed for ${FALLBACK_BREAKER} channels in a row`);
        }
        continue;
      }
      answered = true;
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
  // The first failure stops the other workers; wait for all of them before failing, so none writes into a
  // generation that is being abandoned.
  await Promise.all(
    Array.from({ length: Math.max(1, deps.fallbackConcurrency ?? 2) }, () =>
      worker().catch((e: unknown) => {
        if (!failed) failure = e;
        failed = true;
      }),
    ),
  );
  if (failed) throw failure;
  await writer.flush();
  if (writer.written.programmes === 0) throw new GuideError('No guide data from the provider');
  return { ...writer.written, skipped: dropped };
}
