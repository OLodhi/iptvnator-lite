import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { CurationCategory, CurationView } from '@tv/shared';
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
import { createProviderService } from '../providers/service.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

let fake: FakeXtream;
let app: FastifyInstance;
let db: Db;
let providerId: number;

beforeAll(async () => {
  const categories = [
    { id: '1', name: 'UK| General' },
    { id: '2', name: 'UK| Sports' },
    { id: '3', name: 'US| News' },
    { id: '4', name: 'US| Movies' },
    { id: '5', name: 'Misc' },
  ];
  const items = categories.map((c, i) => ({ id: i + 1, name: `${c.name} channel`, categoryId: c.id }));
  fake = await startFakeXtream({
    mediaDir,
    catalogue: {
      live: { categories, items },
      movie: { categories: [], items: [] },
      series: { categories: [], items: [] },
      episodes: {},
    },
  });
  db = openDb(':memory:');
  const config = testConfig();
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  const catalogue = createCatalogueRepo(db);
  app = await buildApp({
    config, db, providers, catalogue,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions(),
    curation: createCurationService({ db, now: Date.now }),
  });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId, kinds: ['live'] });
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

const url = (kind: string, id = providerId) => `/api/providers/${id}/curation/${kind}`;
const getView = async (): Promise<CurationView> => (await app.inject(url('live'))).json();
const everyCategory = (v: CurationView): CurationCategory[] => [...v.groups.flatMap((g) => g.categories), ...v.untagged];
const shown = (v: CurationView) => everyCategory(v).filter((c) => c.visible).map((c) => c.remoteId);
const put = (payload: unknown, kind = 'live', id = providerId) => app.inject({ method: 'PUT', url: url(kind, id), payload: payload as object });
const rules = () => db.prepare('SELECT * FROM category_rules ORDER BY rowid').all();

test('the picker reads the view, saves choices and hides a category', async () => {
  const before = await getView();
  expect(before.groups.map((g) => g.tag)).toEqual(['UK', 'US']);
  expect(before.untagged.map((c) => c.remoteId)).toEqual(['5']);
  expect(shown(before)).toEqual(['1', '2', '3', '4', '5']);

  const res = await put({ tags: { UK: true, US: false }, categories: { '2': false, '5': true } });
  expect(res.statusCode).toBe(204);
  expect(res.body).toBe('');
  expect(shown(await getView())).toEqual(['1', '5']);

  const general = everyCategory(before).find((c) => c.remoteId === '1')!;
  const hide = await app.inject({ method: 'POST', url: `/api/categories/${general.id}/hide` });
  expect(hide.statusCode).toBe(204);
  expect(shown(await getView())).toEqual(['5']);

  // The owner is the admin: every write goes to the default rules.
  expect(db.prepare('SELECT COUNT(*) FROM category_rules WHERE user_id IS NOT NULL').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM curation_state WHERE user_id IS NULL').pluck().get()).toBe(1);
});

test('an unknown provider or category is 404', async () => {
  for (const res of [
    await app.inject(url('live', 999)),
    await put({ tags: {}, categories: {} }, 'live', 999),
    await app.inject({ method: 'POST', url: '/api/categories/987654/hide' }),
  ]) {
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  }
});

test('an unknown kind is 400', async () => {
  for (const res of [await app.inject(url('tv')), await put({ tags: {}, categories: {} }, 'tv')]) {
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION' });
  }
});

test('the PUT body accepts only true and false', async () => {
  const before = rules();
  for (const body of [
    { tags: { UK: 'yes' }, categories: {} },
    { tags: { UK: 'true' }, categories: {} },
    { tags: { UK: 1 }, categories: {} },
    { tags: {}, categories: { '1': null } },
    { tags: {}, categories: { '1': [true] } },
    { tags: [], categories: {} },
    { tags: {} },
  ]) {
    const res = await put(body);
    expect(res.statusCode, JSON.stringify(body)).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION' });
  }
  expect(rules()).toEqual(before);
});
