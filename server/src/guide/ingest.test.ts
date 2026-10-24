import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream, FakeXtreamOptions } from '../../../tools/fake-xtream/src/server.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { createXtreamClient } from '../providers/xtream/client.ts';
import type { XtreamClient } from '../providers/xtream/client.ts';
import type { Log } from '../util/log.ts';
import { GUIDE_FUTURE_SEC, GuideError, refreshGuide } from './ingest.ts';
import { createGuideStore } from './store.ts';
import type { GuideStore } from './store.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const UA = 'test-agent';
const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
const NOW = NOW_MS / 1000;
const DAY = 86_400;
const HOUR = 3600;
// Nine days ahead, so the eight-day cut-off has programmes to drop.
const WIDE = { pastDays: 3, futureDays: 9, programmeMinutes: 60 };

let fakes: FakeXtream[] = [];
let db: Db;
let store: GuideStore;
let providerId: number;
let timezone: string | null;

async function clientFor(opts: Partial<FakeXtreamOptions> = {}): Promise<XtreamClient> {
  const fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), now: () => NOW_MS, guideWindow: WIDE, ...opts });
  fakes.push(fake);
  return createXtreamClient({ serverUrl: fake.url, username: 'u', password: 'p' }, { userAgent: UA });
}

/** A provider backed by a fake with these options, its live catalogue synced. */
async function setup(opts: Partial<FakeXtreamOptions> = {}): Promise<XtreamClient> {
  const client = await clientFor(opts);
  const providers = createProviderService({ db, userAgent: UA });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fakes[0]!.url, username: 'u', password: 'p' })).id;
  timezone = providers.account(providerId)?.timezone ?? null;
  await syncCatalogue({ db, client, providerId, kinds: ['live'] });
  return client;
}

const liveIds = (): number[] =>
  db.prepare("SELECT id FROM items WHERE provider_id = ? AND kind = 'live' ORDER BY position").pluck().all(providerId) as number[];
const itemId = (remoteId: string): number =>
  db.prepare("SELECT id FROM items WHERE kind = 'live' AND remote_id = ?").pluck().get(remoteId) as number;
const link = (remoteId: string) =>
  db.prepare('SELECT channel_key AS key, method FROM guide_links WHERE item_id = ?').get(itemId(remoteId));
const count = (sql: string, ...args: unknown[]): number => db.prepare(sql).pluck().get(...args) as number;
const column = (sql: string, ...args: unknown[]): unknown[] => db.prepare(sql).pluck().all(...args);
const span = (key: string) =>
  db.prepare('SELECT MIN(start) AS first, MAX(start) AS last, COUNT(*) AS n FROM programmes WHERE channel_key = ?').get(key);

function refresh(client: XtreamClient, extra: Partial<Parameters<typeof refreshGuide>[0]> = {}) {
  return refreshGuide({
    db, store, client, providerId, timezone, visibleLiveItemIds: liveIds, now: () => NOW_MS, fallbackGapMs: 0, ...extra,
  });
}

function recordingLog() {
  const lines: { level: string; o: object; msg: string }[] = [];
  const log: Log = {
    info: (o, msg) => lines.push({ level: 'info', o, msg }),
    warn: (o, msg) => lines.push({ level: 'warn', o, msg }),
  };
  return { log, lines };
}

beforeEach(() => {
  db = openDb(':memory:');
  store = createGuideStore(db);
});
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
  db.close();
});

describe('refreshGuide from xmltv', () => {
  test("stores linked channels' programmes inside the window", async () => {
    const client = await setup();
    const { log, lines } = recordingLog();
    const r = await refresh(client, { log });

    expect(r.source).toBe('xmltv');
    expect(column('SELECT DISTINCT channel_key FROM programmes ORDER BY 1')).toEqual(['hls.uk', 'raw.uk']);
    expect(column('SELECT key FROM guide_channels ORDER BY key')).toEqual(['hls.uk', 'other.uk', 'raw.uk']);
    // hls.uk has a 2-day archive; raw.uk none, so 1 day. Neither keeps anything starting 8 days or more ahead.
    const last = NOW + GUIDE_FUTURE_SEC - HOUR;
    expect(span('hls.uk')).toEqual({ first: NOW - 2 * DAY, last, n: 48 + 192 });
    expect(span('raw.uk')).toEqual({ first: NOW - DAY, last, n: 24 + 192 });
    expect(link('1')).toEqual({ key: 'hls.uk', method: 'id' });
    expect(link('2')).toEqual({ key: 'raw.uk', method: 'id' });

    // The fake sends 12 days of hourly programmes per channel.
    expect(r).toMatchObject({ channels: 3, programmes: 456, skipped: 2 * 288 - 456, linked: 2 });
    expect(store.state(providerId)).toMatchObject({ source: 'xmltv', fetchedAt: NOW, failures: 0, lastError: null });
    const done = lines.find((l) => l.msg === 'guide refreshed');
    expect(done?.o).toEqual({ providerId, source: 'xmltv', channels: 3, programmes: 456, linked: 2, durationMs: r.durationMs });
  });

  test('reads a raw gzip guide', async () => {
    const client = await setup({ guide: 'gzip' });
    const r = await refresh(client);
    expect(r).toMatchObject({ source: 'xmltv', channels: 3, programmes: 456, skipped: 120, linked: 2 });
    expect(span('hls.uk')).toMatchObject({ first: NOW - 2 * DAY, n: 240 });
  });

  test('a second refresh swaps generations and prunes the old one', async () => {
    const client = await setup();
    await refresh(client);
    const first = store.currentGeneration(providerId);
    await refresh(client);
    const second = store.currentGeneration(providerId);
    expect(second).toBeGreaterThan(first);
    expect(column('SELECT DISTINCT generation FROM programmes')).toEqual([second]);
    expect(column('SELECT DISTINCT generation FROM guide_channels')).toEqual([second]);
    expect(count('SELECT COUNT(*) FROM programmes')).toBe(456);
  });

  test("wanted keys are fixed at the first programme and include every item's guide id", async () => {
    const real = await setup();
    const at = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 19).replace(/[-T:]/g, '')} +0000`;
    const prog = (channel: string) =>
      `<programme start="${at(NOW)}" stop="${at(NOW + HOUR)}" channel="${channel}"><title>T</title></programme>`;
    // No <channel> for item 1's id (and in another case); a channel for item 3's name only after programmes began.
    const late = '<channel id="late"><display-name>MPEG-2 Channel</display-name></channel>';
    const xml = `<tv>${prog('HLS.UK')}${late}${prog('late')}</tv>`;
    const client: XtreamClient = { ...real, xmltv: async () => Readable.from([Buffer.from(xml)]) };
    const r = await refresh(client);

    expect(r).toMatchObject({ source: 'xmltv', channels: 1, programmes: 1, skipped: 1 });
    expect(column('SELECT channel_key FROM programmes')).toEqual(['HLS.UK']);
    // The late channel still links once the guide is committed; only its earlier programme was not kept.
    expect(link('3')).toEqual({ key: 'late', method: 'normalised' });
    expect(r.linked).toBe(1);
  });

  test('a failed prune after a good commit still succeeds', async () => {
    const client = await setup();
    const { log, lines } = recordingLog();
    const failingPrune: GuideStore = { ...store, pruneGenerations: () => Promise.reject(new Error('disk full')) };
    const r = await refresh(client, { store: failingPrune, log });
    expect(r.programmes).toBe(456);
    expect(store.currentGeneration(providerId)).toBeGreaterThan(0);
    expect(lines.some((l) => l.level === 'warn' && JSON.stringify(l.o).includes('disk full'))).toBe(true);
  });
});

describe('refreshGuide fallback to the provider EPG', () => {
  test('falls back to the provider EPG when xmltv fails', async () => {
    const client = await setup({ guide: 'none' });
    const r = await refresh(client);

    expect(r.source).toBe('provider');
    // Items 3 and 999 have no listings, so they get no channel.
    expect(column('SELECT key FROM guide_channels ORDER BY key')).toEqual(['stream:1', 'stream:2']);
    expect(db.prepare("SELECT name FROM guide_channels WHERE key = 'stream:1'").pluck().get()).toBe('UK| HLS Channel');
    const last = NOW + GUIDE_FUTURE_SEC - HOUR;
    expect(span('stream:1')).toEqual({ first: NOW - 2 * DAY, last, n: 240 });
    expect(span('stream:2')).toEqual({ first: NOW - DAY, last, n: 216 });
    expect(link('1')).toEqual({ key: 'stream:1', method: 'provider' });
    expect(link('3')).toBeUndefined();
    expect(r).toMatchObject({ channels: 2, programmes: 456, skipped: 120, linked: 2 });
    expect(store.state(providerId)).toMatchObject({ source: 'provider', failures: 0 });
  });

  test('a channel whose listings fail is skipped, within the concurrency and channel limits', async () => {
    const real = await setup({ guide: 'error' });
    const asked: string[] = [];
    const zones: (string | null | undefined)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client: XtreamClient = {
      ...real,
      async epgTable(streamId, o) {
        asked.push(streamId);
        zones.push(o?.tz);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        try {
          await new Promise((r) => setTimeout(r, 20));
          if (streamId === '1') throw new Error('the provider dropped the connection');
          return await real.epgTable(streamId, o);
        } finally {
          inFlight--;
        }
      },
    };
    // Browse order puts item 999 first; the limit leaves out item 3, the last.
    const order = ['999', '2', '1', '3'].map(itemId);
    const r = await refresh(client, { visibleLiveItemIds: () => order, fallbackMaxChannels: 3, fallbackConcurrency: 2 });

    expect(r.source).toBe('provider');
    expect(asked.sort()).toEqual(['1', '2', '999']);
    expect(maxInFlight).toBe(2);
    expect(zones.every((z) => z === 'Europe/London')).toBe(true);
    expect(column('SELECT DISTINCT channel_key FROM programmes')).toEqual(['stream:2']);
    expect(link('1')).toBeUndefined();
    expect(link('2')).toEqual({ key: 'stream:2', method: 'provider' });
  });

  test('each fallback worker waits the gap between its own requests', async () => {
    const real = await setup({ guide: 'none' });
    const times: number[] = [];
    const client: XtreamClient = {
      ...real,
      epgTable(streamId, o) {
        times.push(Date.now());
        return real.epgTable(streamId, o);
      },
    };
    await refresh(client, { fallbackConcurrency: 1, fallbackGapMs: 150 });
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(140);
  });
});

describe('refreshGuide failures keep the current guide', () => {
  async function goodGuide() {
    const client = await setup();
    await refresh(client);
    return {
      generation: store.currentGeneration(providerId),
      programmes: count('SELECT COUNT(*) FROM programmes'),
      links: db.prepare('SELECT * FROM guide_links ORDER BY item_id').all(),
    };
  }
  function expectUnchanged(before: Awaited<ReturnType<typeof goodGuide>>) {
    expect(store.currentGeneration(providerId)).toBe(before.generation);
    expect(count('SELECT COUNT(*) FROM programmes WHERE generation = ?', before.generation)).toBe(before.programmes);
    expect(count('SELECT COUNT(*) FROM programmes WHERE generation <> ?', before.generation)).toBe(0);
    expect(count('SELECT COUNT(*) FROM guide_channels WHERE generation <> ?', before.generation)).toBe(0);
    expect(db.prepare('SELECT * FROM guide_links ORDER BY item_id').all()).toEqual(before.links);
  }

  test('a truncated guide keeps the current one', async () => {
    const before = await goodGuide();
    const bad = await clientFor({ guide: 'truncated', listings: false });
    const err = await refresh(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuideError);
    expect((err as Error).message).toBe('No guide data from the provider');
    expectUnchanged(before);
    expect(store.state(providerId)).toMatchObject({ failures: 1, lastError: 'No guide data from the provider' });
  });

  test('a stalled download times out and keeps the current one', async () => {
    const before = await goodGuide();
    const stalled = await clientFor({ guide: 'stall', listings: false });
    const t0 = Date.now();
    await expect(refresh(stalled, { xmltvIdleTimeoutMs: 300 })).rejects.toThrow(GuideError);
    expect(Date.now() - t0).toBeLessThan(3000);
    expectUnchanged(before);
    expect(store.state(providerId)?.failures).toBe(1);
  });

  test('a total failure rethrows the cause and records it without credentials', async () => {
    const client = await setup({ guide: 'none' });
    const cause = new Error('could not list http://h/live/u/s3cret/1.ts?username=u&password=s3cret');
    const visibleLiveItemIds = () => {
      throw cause;
    };
    await expect(refresh(client, { visibleLiveItemIds })).rejects.toBe(cause);
    const state = store.state(providerId)!;
    expect(state).toMatchObject({ generation: 0, failures: 1 });
    expect(state.lastError).toContain('could not list');
    expect(state.lastError).not.toContain('s3cret');
  });

  test('abort stops the refresh cleanly', async () => {
    // One-minute programmes, so batches are written while the parse is still running.
    const real = await setup({ guideWindow: { pastDays: 3, futureDays: 2, programmeMinutes: 1 } });
    const ac = new AbortController();
    let generation = 0;
    const abortingStore: GuideStore = {
      ...store,
      insertProgrammes(p, g, rows) {
        generation = g;
        const n = store.insertProgrammes(p, g, rows);
        ac.abort();
        return n;
      },
    };
    let epgCalls = 0;
    const client: XtreamClient = {
      ...real,
      epgTable(streamId, o) {
        epgCalls++;
        return real.epgTable(streamId, o);
      },
    };

    await expect(refresh(client, { store: abortingStore, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(generation).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) FROM programmes WHERE generation = ?', generation)).toBe(0);
    expect(count('SELECT COUNT(*) FROM guide_channels WHERE generation = ?', generation)).toBe(0);
    expect(store.currentGeneration(providerId)).toBe(0);
    expect(epgCalls).toBe(0);
    // A caller's abort is not a provider failure, so it starts no backoff.
    expect(store.state(providerId)?.failures).toBe(0);
  });
});
