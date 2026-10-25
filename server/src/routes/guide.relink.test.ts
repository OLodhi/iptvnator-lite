import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { buildApp } from '../app.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { createCurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import type { GuideRunner } from '../guide/runner.ts';
import { createPersonalService } from '../personal/service.ts';
import { createPrefsService } from '../prefs/service.ts';
import { createProviderService } from '../providers/service.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
// Long before the real clock, so the app's injected time and the real one disagree about every listing.
const PINNED = Date.UTC(2020, 5, 1, 12, 0, 0) / 1000;

let fake: FakeXtream;
let app: FastifyInstance;
let db: Db;
let providerId: number;

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), now: () => PINNED * 1000 });
  db = openDb(':memory:');
  const config = testConfig();
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId, kinds: ['live'] });
  // A stub runner, so the refresh the PUT starts cannot replace the guide seeded below.
  const guide = { start: () => undefined } as unknown as GuideRunner;
  const catalogue = createCatalogueRepo(db);
  app = await buildApp({
    config, db, providers, catalogue, guide,
    curation: createCurationService({ db, now: Date.now }),
    personal: createPersonalService({ db, now: Date.now }),
    prefs: createPrefsService(db),
    now: () => PINNED * 1000,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions(),
  });
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

test('the guide-source PUT relinks with the app clock, not the real one', async () => {
  const one = db.prepare("SELECT id, name FROM items WHERE kind = 'live' AND remote_id = '1'").get() as { id: number; name: string };
  const two = db.prepare("SELECT id FROM items WHERE kind = 'live' AND remote_id = '2'").pluck().get() as number;
  db.prepare("INSERT INTO guide_state (provider_id, generation, fetched_at, source) VALUES (?, 1, ?, 'xmltv')").run(providerId, PINNED);
  const channel = db.prepare('INSERT INTO guide_channels (provider_id, generation, key, name, names) VALUES (?, 1, ?, ?, ?)');
  channel.run(providerId, 'hls.uk', 'hls.uk', JSON.stringify(['hls.uk']));
  channel.run(providerId, 'alt.uk', 'alt.uk', JSON.stringify([one.name]));
  const programme = db.prepare('INSERT INTO programmes (provider_id, generation, channel_key, start, stop, title) VALUES (?, 1, ?, ?, ?, ?)');
  // Item 1's own id match is over at PINNED; its name match is still upcoming then, and long past at the real clock.
  programme.run(providerId, 'hls.uk', PINNED - 7200, PINNED - 3600, 'over');
  programme.run(providerId, 'alt.uk', PINNED + 3600, PINNED + 7200, 'upcoming');
  const res = await app.inject({ method: 'PUT', url: `/api/items/${two}/guide-source`, payload: { key: 'alt.uk' } });
  expect(res.statusCode).toBe(204);
  expect(db.prepare('SELECT channel_key, method FROM guide_links WHERE item_id = ?').get(one.id)).toEqual({ channel_key: 'alt.uk', method: 'normalised' });
});
