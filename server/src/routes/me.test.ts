import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SavedPosition } from '@tv/shared';
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
import { createPersonalService } from '../personal/service.ts';
import type { PersonalService } from '../personal/service.ts';
import { createProviderService } from '../providers/service.ts';
import { PlaybackError } from '../playback/sessions.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const USER = 1;

let fake: FakeXtream;
let app: FastifyInstance;
let db: Db;
let personal: PersonalService;
let providerId: number;
let failStart = false;
const warnings: { o: object; m: string }[] = [];

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue() });
  db = openDb(':memory:');
  const config = testConfig();
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  const catalogue = createCatalogueRepo(db);
  personal = createPersonalService({ db, now: Date.now });
  app = await buildApp({
    config, db, providers, catalogue, personal,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions({
      start: async (req) => {
        if (failStart) throw new PlaybackError('PROVIDER_CONNECTION_LIMIT', 'busy');
        return { sessionId: 's1', mode: 'hls', url: `/api/sessions/s1/${req.clientId}/index.m3u8`, durationSec: null, startAtSec: 0 };
      },
    }),
    curation: createCurationService({ db, now: Date.now }),
    log: { info() {}, warn: (o, m) => void warnings.push({ o, m }) },
  });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

beforeEach(() => {
  failStart = false;
  warnings.length = 0;
  vi.restoreAllMocks();
  db.exec('DELETE FROM pins; DELETE FROM favourites; DELETE FROM history; DELETE FROM positions');
});

const item = (kind: string, remoteId: number) =>
  db.prepare('SELECT id FROM items WHERE provider_id = ? AND kind = ? AND remote_id = ?').pluck().get(providerId, kind, String(remoteId)) as number;
const category = (kind: string, remoteId: string) =>
  db.prepare('SELECT id FROM categories WHERE provider_id = ? AND kind = ? AND remote_id = ?').pluck().get(providerId, kind, remoteId) as number;
const send = (method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined });

test('pins can be added and removed, and unknown categories are 404', async () => {
  const c = category('live', '1');
  const added = await send('POST', '/api/me/pins', { categoryId: c });
  expect(added.statusCode).toBe(204);
  expect(personal.pinnedCategoryIds(USER, providerId, 'live')).toEqual([c]);
  expect((await send('DELETE', `/api/me/pins/${c}`)).statusCode).toBe(204);
  expect(personal.pinnedCategoryIds(USER, providerId, 'live')).toEqual([]);

  expect((await send('POST', '/api/me/pins', { categoryId: 98765 })).statusCode).toBe(404);
  expect((await send('DELETE', '/api/me/pins/98765')).json()).toMatchObject({ code: 'NOT_FOUND' });
  expect((await send('POST', '/api/me/pins', { categoryId: 'x' })).json()).toMatchObject({ code: 'VALIDATION' });
});

test('favourites can be added and removed, and unknown items are 404', async () => {
  const m = item('movie', 1);
  expect((await send('POST', '/api/me/favourites', { itemId: m })).statusCode).toBe(204);
  expect(personal.favouriteItemIds(USER, providerId, 'movie')).toEqual([m]);
  expect((await send('DELETE', `/api/me/favourites/${m}`)).statusCode).toBe(204);
  expect(personal.favouriteItemIds(USER, providerId, 'movie')).toEqual([]);

  expect((await send('POST', '/api/me/favourites', { itemId: 98765 })).statusCode).toBe(404);
  expect((await send('DELETE', '/api/me/favourites/98765')).statusCode).toBe(404);
  expect((await send('POST', '/api/me/favourites', {})).statusCode).toBe(400);
});

test('a movie position is saved and read back', async () => {
  const m = item('movie', 1);
  const put = await send('PUT', '/api/me/positions', { itemId: m, positionSec: 120, durationSec: 3600 });
  expect(put.statusCode).toBe(204);
  expect(put.body).toBe('');
  const got = await send('GET', `/api/me/positions/${m}`);
  const [position] = got.json<SavedPosition[]>();
  expect(position).toMatchObject({ episodeRemoteId: null, positionSec: 120, durationSec: 3600, finished: false });
  expect(await send('GET', `/api/me/positions/${item('movie', 2)}`).then((r) => r.json())).toEqual([]);
});

test('an episode position is saved under its series', async () => {
  const s = item('series', 10);
  expect((await send('PUT', '/api/me/positions', { itemId: s, episodeRemoteId: '201', positionSec: 60, durationSec: null })).statusCode).toBe(204);
  expect((await send('GET', `/api/me/positions/${s}`)).json()).toMatchObject([{ episodeRemoteId: '201', positionSec: 60 }]);
  expect(personal.continueWatching(USER, providerId, 'series', 5)).toMatchObject([{ itemId: s, episodeRemoteId: '201' }]);
});

test('position reports are validated', async () => {
  const m = item('movie', 1);
  const s = item('series', 10);
  const put = (body: object) => send('PUT', '/api/me/positions', body);
  expect((await put({ itemId: 98765, positionSec: 10, durationSec: null })).statusCode).toBe(404);
  expect((await put({ itemId: s, episodeRemoteId: 'nope', positionSec: 10, durationSec: null })).statusCode).toBe(404);
  expect((await put({ itemId: m, episodeRemoteId: '201', positionSec: 10, durationSec: null })).statusCode).toBe(400); // not a series
  expect((await put({ itemId: s, positionSec: 10, durationSec: null })).statusCode).toBe(400); // series without an episode
  expect((await put({ itemId: item('live', 1), positionSec: 10, durationSec: null })).statusCode).toBe(400);
  expect((await put({ itemId: m, positionSec: -1, durationSec: null })).statusCode).toBe(400);
  expect((await put({ itemId: m, positionSec: 10 })).statusCode).toBe(400);
  expect((await send('GET', '/api/me/positions/98765')).statusCode).toBe(404);
  expect(db.prepare('SELECT COUNT(*) FROM positions').pluck().get()).toBe(0);
});

test('the play route records history for the current user', async () => {
  const live = item('live', 1);
  const res = await send('POST', '/api/play', { itemId: live, clientId: 'A' });
  expect(res.statusCode).toBe(200);
  expect(personal.recentItemIds(USER, providerId, 'live', 10)).toEqual([live]);

  const s = item('series', 10);
  await send('POST', '/api/play', { itemId: s, episodeRemoteId: '201', clientId: 'A' });
  expect(personal.recentItemIds(USER, providerId, 'series', 10)).toEqual([s]);
  expect(db.prepare("SELECT episode_remote_id FROM history WHERE kind = 'series'").pluck().get()).toBe('201');
});

test('a play that fails to start records nothing', async () => {
  failStart = true;
  const res = await send('POST', '/api/play', { itemId: item('live', 1), clientId: 'A' });
  expect(res.statusCode).toBe(409);
  expect(db.prepare('SELECT COUNT(*) FROM history').pluck().get()).toBe(0);
});

test('a history write that throws never fails a stream that has started', async () => {
  vi.spyOn(personal, 'recordPlay').mockImplementation(() => {
    throw new Error('database is locked');
  });
  const res = await send('POST', '/api/play', { itemId: item('live', 1), clientId: 'A' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ sessionId: 's1', mode: 'hls' });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.m).toBe('play: could not record history');
});
