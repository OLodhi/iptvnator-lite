import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { backoffMs, guideJob } from '../catalogue/scheduler.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { createCurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { DEFAULT_USER_ID } from '../users.ts';
import type { Log } from '../util/log.ts';
import { afterSync, createGuideRunner } from './runner.ts';
import type { GuideRunner } from './runner.ts';
import { createGuideStore } from './store.ts';
import type { GuideStore } from './store.ts';
import { visibleLiveItemIds } from './visible.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);

let fake: FakeXtream;
let db: Db;
let store: GuideStore;
let providers: ProviderService;
let providerId: number;
let runner: GuideRunner | undefined;
let xmltvCalls: number;
const lines: { level: string; o: Record<string, unknown>; msg: string }[] = [];
const log: Log = {
  info: (o, msg) => void lines.push({ level: 'info', o: o as Record<string, unknown>, msg }),
  warn: (o, msg) => void lines.push({ level: 'warn', o: o as Record<string, unknown>, msg }),
};

beforeEach(async () => {
  fake = await startFakeXtream({
    mediaDir, catalogue: smallCatalogue(), now: () => NOW_MS, guideWindow: { pastDays: 3, futureDays: 2, programmeMinutes: 60 },
  });
  db = openDb(':memory:');
  store = createGuideStore(db);
  providers = createProviderService({ db, userAgent: 'ua' });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId, kinds: ['live'] });
  xmltvCalls = 0;
  lines.length = 0;
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  await fake.close();
  db.close();
});

/** The real provider service, with each client's xmltv wrapped (counted, and optionally replaced). */
function wrapped(xmltv?: (signal: AbortSignal | undefined) => Promise<never>): ProviderService {
  return {
    ...providers,
    clientFor: (id: number) => {
      const client = providers.clientFor(id);
      return {
        ...client,
        xmltv: (opts) => {
          xmltvCalls++;
          return xmltv ? xmltv(opts?.signal) : client.xmltv(opts);
        },
      };
    },
  };
}

function makeRunner(over: Partial<Parameters<typeof createGuideRunner>[0]> = {}): GuideRunner {
  const curation = createCurationService({ db, now: Date.now });
  runner = createGuideRunner({
    db,
    store,
    providers: wrapped(),
    visibleLiveItemIds: (id) => visibleLiveItemIds(db, curation, id, DEFAULT_USER_ID),
    now: () => NOW_MS,
    log,
    ...over,
  });
  return runner;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((res) => setTimeout(res, 25));
}

async function settled(r: GuideRunner): Promise<void> {
  await until(() => !r.running(providerId));
}

test('start runs one refresh at a time and reports status', async () => {
  const r = makeRunner();
  expect(r.status(providerId)).toEqual({
    state: 'idle', fetchedAt: null, source: null, channels: 0, programmes: 0, linkedChannels: 0, error: null,
  });
  r.start(providerId);
  expect(r.running(providerId)).toBe(true);
  expect(r.status(providerId).state).toBe('running');
  await settled(r);
  expect(xmltvCalls).toBe(1);
  const status = r.status(providerId);
  expect(status).toMatchObject({ state: 'idle', source: 'xmltv', fetchedAt: NOW_MS, error: null, channels: 3, linkedChannels: 2 });
  expect(status.programmes).toBeGreaterThan(0);
});

test('failure is reported with a redacted error', async () => {
  const leaky = {
    ...providers,
    clientFor: () => {
      throw new Error('connect failed: http://host/player_api.php?username=alice&password=hunter2');
    },
  } as unknown as ProviderService;
  const r = makeRunner({ providers: leaky });
  r.start(providerId);
  await settled(r);
  const status = r.status(providerId);
  expect(status.state).toBe('failed');
  expect(status.error).toContain('connect failed');
  expect(JSON.stringify([status, lines])).not.toMatch(/hunter2|alice/);
  expect(lines.some((l) => l.level === 'warn' && l.msg === 'guide refresh failed')).toBe(true);
  // A later success clears the failure.
  runner = undefined;
  const ok = makeRunner();
  ok.start(providerId);
  await settled(ok);
  expect(ok.status(providerId)).toMatchObject({ state: 'idle', error: null });
});

test('onSynced relinks and starts the first guide refresh', async () => {
  const r = makeRunner();
  const sync = createSyncRunner({ db, providers, onSynced: afterSync(r, store), log });
  sync.start(providerId);
  for (let i = 0; i < 400 && (sync.status(providerId).state === 'running' || r.running(providerId) || !store.state(providerId)?.fetchedAt); i++) {
    await new Promise((res) => setTimeout(res, 25));
  }
  expect(r.status(providerId)).toMatchObject({ state: 'idle', source: 'xmltv', linkedChannels: 2 });

  // With a guide already stored, a later sync only relinks: no new refresh, links rebuilt.
  const before = store.state(providerId)?.attemptedAt;
  const calls = xmltvCalls;
  db.prepare('DELETE FROM guide_links WHERE provider_id = ?').run(providerId);
  expect(r.status(providerId).linkedChannels).toBe(0);
  const again = createSyncRunner({ db, providers, onSynced: afterSync(r, store), log });
  again.start(providerId);
  // The relink runs in the background after the sync.
  await until(() => again.status(providerId).state !== 'running' && r.status(providerId).linkedChannels > 0);
  expect(again.status(providerId).state).toBe('idle');
  expect(r.running(providerId)).toBe(false);
  expect(r.status(providerId).linkedChannels).toBe(2);
  expect(store.state(providerId)?.attemptedAt).toBe(before);
  expect(xmltvCalls).toBe(calls);
});

test('afterSync returns at once and relinks in the background', async () => {
  const r = makeRunner();
  r.start(providerId);
  await settled(r);
  db.prepare('DELETE FROM guide_links WHERE provider_id = ?').run(providerId);
  afterSync(r, store, log)(providerId);
  expect(r.status(providerId).linkedChannels).toBe(0);
  await until(() => r.status(providerId).linkedChannels > 0);
  expect(r.status(providerId).linkedChannels).toBe(2);
});

test('a failed after-sync relink is logged redacted, and the first refresh still starts', async () => {
  let started = 0;
  const failing: GuideRunner = {
    ...makeRunner(),
    relink: () => Promise.reject(new Error('relink failed http://h/x?username=alice&password=hunter2')),
    start: () => void started++,
  };
  afterSync(failing, store, log)(providerId);
  await until(() => lines.some((l) => l.msg === 'guide relink after sync failed'));
  const line = lines.find((l) => l.msg === 'guide relink after sync failed');
  expect(line).toMatchObject({ level: 'warn', o: { providerId } });
  expect(JSON.stringify(line)).not.toMatch(/hunter2|alice/);
  expect(started).toBe(1); // no guide stored yet
});

test('a failure before the refresh starts is recorded and anchors the backoff', async () => {
  let attempts = 0;
  const broken = {
    ...providers,
    clientFor: () => {
      attempts++;
      throw new Error('no client http://h/x?username=alice&password=hunter2');
    },
  } as unknown as ProviderService;
  const r = makeRunner({ providers: broken });
  providers.markSynced(providerId, NOW_MS - 1000);
  const job = guideJob({ providers, guide: r, store });
  expect(job.due(providerId, NOW_MS)).toBe(true);

  r.start(providerId);
  await settled(r);
  expect(store.state(providerId)).toMatchObject({ failures: 1, attemptedAt: NOW_MS / 1000, fetchedAt: null });
  expect(job.due(providerId, NOW_MS + backoffMs(1) - 1)).toBe(false);
  expect(job.due(providerId, NOW_MS + backoffMs(1))).toBe(true);

  r.start(providerId);
  await settled(r);
  expect(attempts).toBe(2);
  expect(store.state(providerId)).toMatchObject({ failures: 2, attemptedAt: NOW_MS / 1000 });
  expect(job.due(providerId, NOW_MS + backoffMs(2) - 1)).toBe(false);
  expect(job.due(providerId, NOW_MS + backoffMs(2))).toBe(true);
  expect(JSON.stringify([r.status(providerId), lines])).not.toMatch(/hunter2|alice/);
});

test('stop aborts a running refresh', async () => {
  const stalled = wrapped((signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))));
  const r = makeRunner({ providers: stalled });
  r.start(providerId);
  await new Promise((res) => setTimeout(res, 50));
  expect(r.running(providerId)).toBe(true);
  await r.stop();
  expect(r.running(providerId)).toBe(false);
  // An abort is not a failure.
  expect(lines.map((l) => l.msg)).toContain('guide refresh aborted');
  expect(lines.map((l) => l.msg)).not.toContain('guide refresh failed');
  expect(store.state(providerId)?.failures ?? 0).toBe(0);
  expect(r.status(providerId).state).toBe('idle');
  r.start(providerId);
  expect(r.running(providerId)).toBe(false);
});

test('start while running queues exactly one more refresh, never concurrent', async () => {
  let inFlight = 0;
  let overlapped = false;
  const counted = {
    ...providers,
    clientFor: (id: number) => {
      const client = providers.clientFor(id);
      return {
        ...client,
        xmltv: async (opts?: Parameters<typeof client.xmltv>[0]) => {
          xmltvCalls++;
          if (++inFlight > 1) overlapped = true;
          try {
            await new Promise((res) => setTimeout(res, 50));
            return await client.xmltv(opts);
          } finally {
            inFlight--;
          }
        },
      };
    },
  } as ProviderService;
  const r = makeRunner({ providers: counted });
  r.start(providerId);
  r.start(providerId);
  r.start(providerId);
  await settled(r);
  expect(xmltvCalls).toBe(2);
  expect(overlapped).toBe(false);
  expect(r.running(providerId)).toBe(false);
});

test('nothing is queued after stop', async () => {
  const stalled = wrapped((signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))));
  const r = makeRunner({ providers: stalled });
  r.start(providerId);
  r.start(providerId);
  await new Promise((res) => setTimeout(res, 50));
  await r.stop();
  expect(r.running(providerId)).toBe(false);
  expect(xmltvCalls).toBe(1);
});
