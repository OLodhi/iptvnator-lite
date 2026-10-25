import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { syncCatalogue } from '../catalogue/sync.ts';
import { createCurationService } from '../curation/service.ts';
import type { CurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { startGeneratedFake } from '../testing/generatedFake.ts';
import { DEFAULT_USER_ID } from '../users.ts';
import { GUIDE_FUTURE_SEC, refreshGuide } from './ingest.ts';
import type { GuideRefreshResult } from './ingest.ts';
import { createGuideQueries } from './query.ts';
import type { GuideQueries } from './query.ts';
import { createGuideStore } from './store.ts';
import type { GuideStore } from './store.ts';
import { visibleLiveItemIds } from './visible.ts';

// 3,000 guide channels of hourly programmes from 7 days back to 3 days ahead (about 720,000 programmes); a fifth of
// them have an archive, of the fake's 7 days.
const GUIDE = { channels: 3000, archivePercent: 20, pastDays: 7, futureDays: 3, programmeMinutes: 60 };
const ARCHIVE_DAYS = 7;
const DAY = 86_400;
const HOUR = 3600;
/** The what's-on route's largest page. */
const WHATS_ON_PAGE = 200;
/** The ingest and the second refresh each have a 120 s budget; a breach must fail on the budget, not on the timeout. */
const REFRESH_TIMEOUT_MS = 180_000;
const DELAY_RESOLUTION_MS = 10;

let fake: Awaited<ReturnType<typeof startGeneratedFake>>;
let tmp: string;
let db: Db;
let providers: ProviderService;
let providerId: number;
let curation: CurationService;
let store: GuideStore;
let queries: GuideQueries;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-guide-scale-'));
  const { channels, archivePercent, pastDays, futureDays, programmeMinutes } = GUIDE;
  fake = await startGeneratedFake('50000,200000,50000,400', {
    guide: [channels, archivePercent, pastDays, futureDays, programmeMinutes].join(','),
  });
  db = openDb(path.join(tmp, 'scale.sqlite'));
  providers = createProviderService({ db, userAgent: 'scale' });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
  curation = createCurationService({ db, now: Date.now });
  store = createGuideStore(db);
  queries = createGuideQueries(db);
}, 120_000);

afterAll(() => {
  db?.close();
  fake?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const refresh = (nowMs: number): Promise<GuideRefreshResult> =>
  refreshGuide({
    db,
    store,
    client: providers.clientFor(providerId),
    providerId,
    timezone: providers.account(providerId)?.timezone ?? null,
    visibleLiveItemIds: () => visibleLiveItemIds(db, curation, providerId, DEFAULT_USER_ID),
    now: () => nowMs,
  });

/**
 * The fake's programmes per channel (every `programmeMinutes` from the hour `pastDays` back until `futureDays` ahead),
 * and how many ingest keeps: those still running inside the channel's past window (its archive days, at least one)
 * and starting less than GUIDE_FUTURE_SEC ahead.
 */
function expectedCounts(nowSec: number): { generated: number; stored: number } {
  const step = GUIDE.programmeMinutes * 60;
  const starts: number[] = [];
  for (let s = Math.floor((nowSec - GUIDE.pastDays * DAY) / HOUR) * HOUR; s < nowSec + GUIDE.futureDays * DAY; s += step) {
    starts.push(s);
  }
  const kept = (pastDays: number) => starts.filter((s) => s + step > nowSec - pastDays * DAY && s < nowSec + GUIDE_FUTURE_SEC).length;
  const archived = (GUIDE.channels * GUIDE.archivePercent) / 100;
  return { generated: GUIDE.channels * starts.length, stored: archived * kept(ARCHIVE_DAYS) + (GUIDE.channels - archived) * kept(1) };
}

/**
 * Within one programme per channel: the fake reads its own clock, a moment after ours, which can move its grid across
 * an hour boundary and so by at most one slot per channel.
 */
function expectNear(actual: number, expected: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual}, expected about ${expected}`).toBeLessThanOrEqual(GUIDE.channels);
}

type Measured<T> = { result: T; seconds: number; maxDelayMs: number; rssGrowthMb: number };

/** Runs `f`, measuring its wall time, the worst event-loop delay and the peak RSS growth across the whole run. */
async function measure<T>(f: () => Promise<T>): Promise<Measured<T>> {
  global.gc?.();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };
  const sampler = setInterval(sample, 100);
  const delay = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  delay.enable();
  const t0 = performance.now();
  let result: T;
  let seconds: number;
  try {
    result = await f();
  } finally {
    seconds = (performance.now() - t0) / 1000;
    // A block just before `f` settles is recorded only once the monitor's timer fires after it.
    await sleep(2 * DELAY_RESOLUTION_MS);
    delay.disable();
    clearInterval(sampler);
  }
  sample();
  return { result, seconds, maxDelayMs: delay.max / 1e6, rssGrowthMb: (peak - baseline) / 1024 / 1024 };
}

/** Median of three timed runs after a warm-up, so one GC pause cannot fail a budget. */
function medianMs(f: () => unknown): number {
  f();
  const runs = [0, 1, 2].map(() => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  });
  return runs.sort((a, b) => a - b)[1]!;
}

const programmeRows = () => db.prepare('SELECT COUNT(*) FROM programmes WHERE provider_id = ?').pluck().get(providerId) as number;
const generationsIn = (table: string) =>
  db.prepare(`SELECT DISTINCT generation FROM ${table} WHERE provider_id = ? ORDER BY generation`).pluck().all(providerId) as number[];

test(
  'ingests about 720,000 programmes in under 120 s, never blocking the event loop 300 ms, under +400 MB RSS',
  async () => {
    expect(db.prepare('SELECT COUNT(*) FROM items WHERE epg_channel_id IS NOT NULL').pluck().get()).toBe(GUIDE.channels);
    const nowMs = Date.now();
    const expected = expectedCounts(Math.floor(nowMs / 1000));

    const m = await measure(() => refresh(nowMs));
    console.log(
      `SCALE guide ingest=${m.seconds.toFixed(1)}s maxEventLoopDelay=${m.maxDelayMs.toFixed(0)}ms ` +
        `peakRssDelta=${m.rssGrowthMb.toFixed(0)}MB programmes=${m.result.programmes} skipped=${m.result.skipped} ` +
        `expectedStored=${expected.stored} generated=${expected.generated}`,
    );

    expect(m.result.source).toBe('xmltv');
    expect(m.result.channels).toBe(GUIDE.channels + 1); // and the fake's unwanted 'other.uk'
    expect(m.result.linked).toBe(GUIDE.channels);
    expectNear(m.result.programmes + m.result.skipped, expected.generated, 'programmes parsed');
    expectNear(m.result.programmes, expected.stored, 'programmes stored');
    expect(programmeRows()).toBe(m.result.programmes);
    expect(m.seconds).toBeLessThan(120);
    expect(m.maxDelayMs).toBeLessThan(300);
    expect(m.rssGrowthMb).toBeLessThan(400);
  },
  REFRESH_TIMEOUT_MS,
);

test('guide queries over the full guide stay within their budgets', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const order = visibleLiveItemIds(db, curation, providerId, DEFAULT_USER_ID);
  expect(order).toHaveLength(50_000);
  const linked = queries.linkedItemIds(providerId, order);
  const guided = order.filter((id) => linked.has(id)); // in browse order, every one with programmes airing now
  expect(guided).toHaveLength(GUIDE.channels);

  const nowFor = medianMs(() => queries.nowFor(providerId, guided.slice(0, 100), nowSec));
  const now = medianMs(() => queries.whatsOn({ providerId, order, mode: 'now', nowSec, cursor: null, limit: WHATS_ON_PAGE }));
  const range = medianMs(() =>
    queries.whatsOn({ providerId, order, mode: 'range', fromSec: nowSec, toSec: nowSec + 8 * HOUR, nowSec, cursor: null, limit: WHATS_ON_PAGE }),
  );
  const past = medianMs(() =>
    queries.whatsOn({ providerId, order, mode: 'past', fromSec: nowSec - DAY, toSec: nowSec, nowSec, cursor: null, limit: WHATS_ON_PAGE }),
  );
  const grid = medianMs(() => queries.programmesFor(providerId, guided.slice(0, 30), nowSec, nowSec + 6 * HOUR));
  console.log(
    `SCALE guide nowFor(100)=${nowFor.toFixed(1)}ms whatsOn now=${now.toFixed(1)}ms range(8h)=${range.toFixed(1)}ms ` +
      `past(24h)=${past.toFixed(1)}ms programmesFor(30, 6h)=${grid.toFixed(1)}ms`,
  );

  // The answers are real, not empty pages that would be fast for the wrong reason.
  expect(queries.nowFor(providerId, guided.slice(0, 100), nowSec).size).toBe(100);
  const airing = queries.whatsOn({ providerId, order, mode: 'now', nowSec, cursor: null, limit: WHATS_ON_PAGE }).items;
  expect(airing).toHaveLength(WHATS_ON_PAGE);
  for (const { programme } of airing) expect(programme.startSec <= nowSec && nowSec < programme.stopSec).toBe(true);
  const upcoming = queries.whatsOn({ providerId, order, mode: 'range', fromSec: nowSec, toSec: nowSec + 8 * HOUR, nowSec, cursor: null, limit: WHATS_ON_PAGE });
  expect(upcoming.items).toHaveLength(WHATS_ON_PAGE);
  expect(upcoming.nextCursor).not.toBeNull();
  const earlier = queries.whatsOn({ providerId, order, mode: 'past', fromSec: nowSec - DAY, toSec: nowSec, nowSec, cursor: null, limit: WHATS_ON_PAGE });
  expect(earlier.items).toHaveLength(WHATS_ON_PAGE);
  const rows = queries.programmesFor(providerId, guided.slice(0, 30), nowSec, nowSec + 6 * HOUR);
  expect(rows.size).toBe(30);
  for (const list of rows.values()) expect(list.length).toBeGreaterThanOrEqual(6);

  expect(nowFor).toBeLessThan(50);
  expect(now).toBeLessThan(300);
  expect(range).toBeLessThan(500);
  expect(past).toBeLessThan(300); // the same what's-on route as now mode
  expect(grid).toBeLessThan(100);
});

test(
  'a second refresh swaps in a new generation and prunes the old one in under 120 s without blocking 300 ms',
  async () => {
    const first = store.currentGeneration(providerId);
    const nowMs = Date.now();
    const m = await measure(() => refresh(nowMs));
    const current = store.currentGeneration(providerId);
    console.log(
      `SCALE guide second refresh=${m.seconds.toFixed(1)}s maxEventLoopDelay=${m.maxDelayMs.toFixed(0)}ms ` +
        `peakRssDelta=${m.rssGrowthMb.toFixed(0)}MB programmes=${m.result.programmes}`,
    );

    expect(current).toBeGreaterThan(first);
    expect(generationsIn('programmes')).toEqual([current]);
    expect(generationsIn('guide_channels')).toEqual([current]);
    expect(m.result.linked).toBe(GUIDE.channels);
    expectNear(m.result.programmes, expectedCounts(Math.floor(nowMs / 1000)).stored, 'programmes stored');
    expect(programmeRows()).toBe(m.result.programmes);
    expect(m.seconds).toBeLessThan(120);
    expect(m.maxDelayMs).toBeLessThan(300);
  },
  REFRESH_TIMEOUT_MS,
);
