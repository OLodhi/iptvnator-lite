import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { buildApp } from '../app.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { createPersonalService } from '../personal/service.ts';
import { createCurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const SECRET = 'p-secret-123';

let fake: FakeXtream;
let app: FastifyInstance;
const onAdded = vi.fn();

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, password: SECRET });
  const config = testConfig();
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent, onAdded });
  const catalogue = createCatalogueRepo(db);
  app = await buildApp({
    config, db, providers, catalogue,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions(),
    curation: createCurationService({ db, now: Date.now }),
    personal: createPersonalService({ db, now: Date.now }),
  });
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'xtream',
  serverUrl: fake.url,
  username: 'u',
  password: SECRET,
  ...over,
});

test('adds a provider after testing the connection', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/providers', payload: body() });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ id: expect.any(Number), name: '127.0.0.1', kind: 'xtream', maxConnections: 1 });
  expect(onAdded).toHaveBeenCalledWith(res.json().id);
});

test('never returns credentials', async () => {
  const post = await app.inject({ method: 'POST', url: '/api/providers', payload: body({ name: 'Mine' }) });
  const list = await app.inject({ method: 'GET', url: '/api/providers' });
  expect(list.statusCode).toBe(200);
  expect(list.json().length).toBeGreaterThan(0);
  for (const text of [post.body, list.body]) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('"u"');
    expect(text).not.toContain('username');
    expect(text).not.toContain('password');
  }
});

test('maps provider errors to 422 with the error code', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/providers', payload: body({ password: 'wrong' }) });
  expect(bad.statusCode).toBe(422);
  expect(bad.json()).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  const down = await app.inject({
    method: 'POST',
    url: '/api/providers',
    payload: body({ serverUrl: 'http://127.0.0.1:1' }),
  });
  expect(down.statusCode).toBe(422);
  expect(down.json()).toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
});

test('rejects missing fields with 400 VALIDATION', async () => {
  const { username: _omit, ...rest } = body();
  const res = await app.inject({ method: 'POST', url: '/api/providers', payload: rest });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ code: 'VALIDATION' });
});
