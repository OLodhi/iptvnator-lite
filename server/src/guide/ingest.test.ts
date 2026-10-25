import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { generateCatalogue, smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream, FakeXtreamOptions } from '../../../tools/fake-xtream/src/server.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { ProviderError } from '../providers/errors.ts';
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
// One-minute programmes, so batches are written while a refresh is still running.
const MINUTELY = { pastDays: 3, futureDays: 2, programmeMinutes: 1 };
const AUTH_FAILED = () => new ProviderError('PROVIDER_AUTH_FAILED', 'The provider rejected the credentials');

const at = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 19).replace(/[-T:]/g, '')} +0000`;
const xmlChannel = (id: string, name: string) => `<channel id="${id}"><display-name>${name}</display-name></channel>`;
const xmlProgramme = (channel: string, start = NOW, minutes = 60) =>
  `<programme start="${at(start)}" stop="${at(start + minutes * 60)}" channel="${channel}"><title>T</title></programme>`;
/** The client, but its xmltv.php is this hand-written document. */
const feeding = (client: XtreamClient, xml: string): XtreamClient => ({
  ...client,
  xmltv: async () => Readable.from([Buffer.from(xml)]),
});
const hundredChannels = () => generateCatalogue({ live: 100, movie: 0, series: 0, categoriesPerKind: 2 });
/** Provider listings every minute from now, enough to fill a batch. */
const minuteListings = (n = 2500) =>
  Array.from({ length: n }, (_, i) => ({ title: 'T', description: null, start: NOW + i * 60, stop: NOW + i * 60 + 60 }));

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
    // hls.uk is declared but its programmes say HLS.UK; raw.uk (item 2's id) is never declared; nothing wants
    // other.uk; a channel for item 3's name arrives only after programmes began.
    const xml =
      `<tv>${xmlChannel('hls.uk', 'HLS Channel')}${xmlChannel('other.uk', 'Other Channel')}` +
      `${xmlProgramme('HLS.UK')}${xmlProgramme('RAW.UK')}${xmlProgramme('other.uk')}${xmlProgramme('other.uk', NOW + HOUR)}` +
      `${xmlChannel('late', 'MPEG-2 Channel')}${xmlProgramme('late')}</tv>`;
    const r = await refresh(feeding(real, xml));

    // Skipped: both other.uk programmes and the late channel's.
    expect(r).toMatchObject({ source: 'xmltv', channels: 3, programmes: 2, skipped: 3, linked: 2 });
    // Stored under the declared id when there is one, else as the programme names it.
    expect(column('SELECT channel_key FROM programmes ORDER BY 1')).toEqual(['RAW.UK', 'hls.uk']);
    expect(link('1')).toEqual({ key: 'hls.uk', method: 'id' });
    // The late channel still links once the guide is committed; only its programme was not kept.
    expect(link('3')).toEqual({ key: 'late', method: 'normalised' });
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

  test('a guide with no wanted programmes falls back and leaves nothing of its own behind', async () => {
    const real = await setup();
    const xml = `<tv>${xmlChannel('other.uk', 'Other Channel')}${xmlChannel('nobody.uk', 'Nobody')}${xmlProgramme('other.uk')}</tv>`;
    const written: string[] = [];
    const spy: GuideStore = {
      ...store,
      insertChannels(p, g, rows) {
        written.push(...rows.map((r) => r.key));
        store.insertChannels(p, g, rows);
      },
      // Pruning after the commit would clear an orphan too; without it, only the abandon can.
      pruneGenerations: async () => 0,
    };
    const r = await refresh(feeding(real, xml), { store: spy });

    expect(r.source).toBe('provider');
    expect(written).toContain('other.uk'); // the xmltv generation did write rows before it was abandoned
    expect(column('SELECT key FROM guide_channels ORDER BY key')).toEqual(['stream:1', 'stream:2']);
    expect(column('SELECT DISTINCT channel_key FROM programmes ORDER BY 1')).toEqual(['stream:1', 'stream:2']);
  });

  test('an xmltv auth failure skips the fallback', async () => {
    await setup();
    const wrong = createXtreamClient({ serverUrl: fakes[0]!.url, username: 'u', password: 'wrong' }, { userAgent: UA });
    let epgCalls = 0;
    const client: XtreamClient = {
      ...wrong,
      epgTable(streamId, o) {
        epgCalls++;
        return wrong.epgTable(streamId, o);
      },
    };
    await expect(refresh(client)).rejects.toMatchObject({ name: 'ProviderError', code: 'PROVIDER_AUTH_FAILED' });
    expect(epgCalls).toBe(0);
    expect(store.state(providerId)).toMatchObject({ generation: 0, failures: 1, lastError: 'The provider rejected the credentials' });
  });

  test('an auth failure in the fallback stops every worker', async () => {
    const real = await setup({ guide: 'none', catalogue: hundredChannels() });
    let calls = 0;
    const client: XtreamClient = {
      ...real,
      async epgTable() {
        if (++calls > 2) throw AUTH_FAILED();
        return [];
      },
    };
    await expect(refresh(client, { fallbackConcurrency: 2 })).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect(calls).toBeLessThanOrEqual(4); // of 100 channels
    expect(store.state(providerId)).toMatchObject({
      generation: 0,
      failures: 1,
      lastError: 'XMLTV: The provider returned HTTP 404; provider EPG: The provider rejected the credentials',
    });
  });

  test('ten failed channels in a row, before any success, trip the breaker', async () => {
    const real = await setup({ guide: 'none', catalogue: hundredChannels() });
    let calls = 0;
    const client: XtreamClient = {
      ...real,
      async epgTable() {
        calls++;
        throw new Error('socket hang up');
      },
    };
    const err = await refresh(client, { fallbackConcurrency: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    expect(calls).toBe(10);
    expect(store.state(providerId)).toMatchObject({ generation: 0, failures: 1 });
  });

  test('failed channels after a success are only channels without listings', async () => {
    const real = await setup({ guide: 'none', catalogue: hundredChannels() });
    let calls = 0;
    const client: XtreamClient = {
      ...real,
      async epgTable() {
        if (++calls > 1) throw new Error('socket hang up');
        return [{ title: 'News', description: null, start: NOW, stop: NOW + HOUR }];
      },
    };
    const r = await refresh(client, { fallbackConcurrency: 1 });
    expect(calls).toBe(100);
    expect(r).toMatchObject({ source: 'provider', channels: 1, programmes: 1 });
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
    expect(store.state(providerId)?.failures).toBe(1);
    expect(store.state(providerId)?.lastError).toMatch(/^XMLTV: .+; provider EPG: No guide data from the provider$/);
  });

  test('a guide cut off after batches were written keeps the current one', async () => {
    const before = await goodGuide();
    const quiet = await clientFor({ listings: false });
    // 500 filler channels and 2,100 in-window programmes, so a batch of each is written before the cut.
    const filler = Array.from({ length: 500 }, (_, i) => xmlChannel(`filler${i}`, `Filler ${i}`)).join('');
    const minutes = Array.from({ length: 2100 }, (_, i) => xmlProgramme('hls.uk', NOW + i * 60, 1)).join('');
    const xml = `<tv>${xmlChannel('hls.uk', 'HLS Channel')}${xmlChannel('raw.uk', 'Raw TS Channel')}${filler}${minutes}<programme start="${at(NOW)}" st`;
    const written = { channels: 0, programmes: 0 };
    const spy: GuideStore = {
      ...store,
      insertChannels(p, g, rows) {
        store.insertChannels(p, g, rows);
        written.channels += rows.length;
      },
      insertProgrammes(p, g, rows) {
        const n = store.insertProgrammes(p, g, rows);
        written.programmes += n;
        return n;
      },
    };
    await expect(refresh(feeding(quiet, xml), { store: spy })).rejects.toThrow(GuideError);
    expect(written).toEqual({ channels: 500, programmes: 2000 });
    expectUnchanged(before);
    expect(store.state(providerId)?.failures).toBe(1);
  });

  test('a fallback that fails after writing a batch keeps the current one', async () => {
    const before = await goodGuide();
    const real = await clientFor({ guide: 'none' });
    const client: XtreamClient = { ...real, epgTable: async () => minuteListings() };
    let batches = 0;
    const spy: GuideStore = {
      ...store,
      insertProgrammes(p, g, rows) {
        if (++batches > 1) throw new Error('disk full');
        return store.insertProgrammes(p, g, rows);
      },
    };
    await expect(refresh(client, { store: spy })).rejects.toThrow('disk full');
    expect(batches).toBeGreaterThanOrEqual(2); // the first was written; each worker may fail one
    expectUnchanged(before);
    expect(store.state(providerId)).toMatchObject({
      failures: 1,
      lastError: 'XMLTV: The provider returned HTTP 404; provider EPG: disk full',
    });
  });

  test('a failed commit after new links were written rolls them back and keeps the current one', async () => {
    const before = await goodGuide();
    // A manual pick makes the new links differ from the current ones.
    db.prepare("INSERT INTO guide_maps (provider_id, item_remote_id, channel_key) VALUES (?, '1', 'other.uk')").run(providerId);
    // Only the commit sets guide_state.generation: beginGeneration and recordFailure leave it alone.
    db.exec("CREATE TEMP TRIGGER no_commit BEFORE UPDATE OF generation ON guide_state BEGIN SELECT RAISE(ABORT, 'commit exploded'); END");
    await expect(refresh(await clientFor())).rejects.toThrow('commit exploded');
    expectUnchanged(before);
    expect(link('1')).toEqual({ key: 'hls.uk', method: 'id' });
    expect(store.state(providerId)).toMatchObject({ failures: 1, lastError: 'commit exploded' });
  });

  test('a failed link write keeps the current one', async () => {
    const before = await goodGuide();
    db.exec("CREATE TEMP TRIGGER no_links BEFORE INSERT ON guide_links BEGIN SELECT RAISE(ABORT, 'links exploded'); END");
    await expect(refresh(await clientFor())).rejects.toThrow('links exploded');
    expectUnchanged(before);
    // The old guide is still reachable through its links.
    const reachable = count(
      `SELECT COUNT(*) FROM guide_links l JOIN guide_state s ON s.provider_id = l.provider_id
         JOIN programmes p ON p.provider_id = l.provider_id AND p.generation = s.generation AND p.channel_key = l.channel_key
        WHERE l.item_id = ?`,
      itemId('1'),
    );
    expect(reachable).toBe(240);
    expect(store.state(providerId)).toMatchObject({ failures: 1, lastError: 'links exploded' });
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

  test('a total failure rethrows the cause and records both reasons without credentials', async () => {
    const real = await setup();
    const client: XtreamClient = {
      ...real,
      xmltv: () => Promise.reject(new Error('could not fetch http://h/xmltv.php?username=u&password=s3cret')),
    };
    const cause = new Error('could not list http://h/live/u/s3cret/1.ts?username=u&password=s3cret');
    const visibleLiveItemIds = () => {
      throw cause;
    };
    await expect(refresh(client, { visibleLiveItemIds })).rejects.toBe(cause);
    expect(store.state(providerId)).toMatchObject({
      generation: 0,
      failures: 1,
      lastError:
        'XMLTV: could not fetch http://h/xmltv.php?username=***&password=***; ' +
        'provider EPG: could not list http://h/live/***/***/1.ts?username=***&password=***',
    });
  });

  test('abort during the fallback stops every worker cleanly', async () => {
    const real = await setup({ guide: 'none' });
    const ac = new AbortController();
    let calls = 0;
    let inFlight = 0;
    const client: XtreamClient = {
      ...real,
      async epgTable(streamId, o) {
        const n = ++calls;
        if (n === 3) ac.abort(); // a worker has finished a channel, and a batch was written, by now
        inFlight++;
        try {
          if (n > 2) return await real.epgTable(streamId, o);
          await new Promise((r) => setTimeout(r, 10));
          return minuteListings();
        } finally {
          inFlight--;
        }
      },
    };
    let generation = 0;
    let written = 0;
    const spy: GuideStore = {
      ...store,
      insertProgrammes(p, g, rows) {
        generation = g;
        const n = store.insertProgrammes(p, g, rows);
        written += n;
        return n;
      },
    };

    await expect(refresh(client, { store: spy, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(inFlight).toBe(0);
    expect(written).toBeGreaterThan(0);
    const callsAtRejection = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(callsAtRejection);
    expect(count('SELECT COUNT(*) FROM programmes WHERE generation = ?', generation)).toBe(0);
    expect(count('SELECT COUNT(*) FROM guide_channels WHERE generation = ?', generation)).toBe(0);
    expect(store.currentGeneration(providerId)).toBe(0);
    expect(store.state(providerId)?.failures).toBe(0);
  });

  test('abort stops the refresh cleanly', async () => {
    const real = await setup({ guideWindow: MINUTELY });
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
