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
import { createGuideRunner } from '../guide/runner.ts';
import type { GuideRunner } from '../guide/runner.ts';
import { createGuideStore } from '../guide/store.ts';
import { createPersonalService } from '../personal/service.ts';
import { createProviderService } from '../providers/service.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

let fake: FakeXtream;
let app: FastifyInstance;
let guide: GuideRunner;
let providerId: number;

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue() });
  const db = openDb(':memory:');
  const config = testConfig();
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId, kinds: ['live'] });
  guide = createGuideRunner({ db, store: createGuideStore(db), providers, visibleLiveItemIds: () => [] });
  const catalogue = createCatalogueRepo(db);
  app = await buildApp({
    config, db, providers, catalogue, guide,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions(),
    curation: createCurationService({ db, now: Date.now }),
    personal: createPersonalService({ db, now: Date.now }),
  });
});

afterAll(async () => {
  await guide.stop();
  await app.close();
  await fake.close();
});

test('POST starts and GET reports', async () => {
  const post = await app.inject({ method: 'POST', url: `/api/providers/${providerId}/guide` });
  expect(post.statusCode).toBe(202);
  expect(post.json()).toEqual({ started: true });
  for (let i = 0; i < 200 && guide.running(providerId); i++) await new Promise((r) => setTimeout(r, 25));
  const res = await app.inject(`/api/providers/${providerId}/guide`);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ state: 'idle', source: 'xmltv', error: null });
  expect(res.json().fetchedAt).toEqual(expect.any(Number));
});

test('unknown provider is 404', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/providers/999/guide' })).statusCode).toBe(404);
  expect((await app.inject('/api/providers/999/guide')).statusCode).toBe(404);
});
