import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { ImportResult } from '@tv/shared';
import { buildApp } from '../app.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { createCurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createPersonalService } from '../personal/service.ts';
import { createProviderService } from '../providers/service.ts';
import { iptvnatorFixture, SERVER } from '../testing/iptvnatorDb.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-import-route-test-'));
const spool = path.join(dir, 'spool');
let app: FastifyInstance;
let db: Db;
let providerId: number;

beforeAll(async () => {
  fs.mkdirSync(spool);
  db = openDb(':memory:');
  const config = testConfig();
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  const catalogue = createCatalogueRepo(db);
  app = await buildApp({
    config, db, providers, catalogue, tmpDir: spool,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions(),
    curation: createCurationService({ db, now: Date.now }),
    personal: createPersonalService({ db, now: Date.now }),
  });
  providerId = Number(
    db
      .prepare(`INSERT INTO providers (kind, name, config, account, created_at) VALUES ('xtream', 'p', ?, NULL, 0)`)
      .run(JSON.stringify({ serverUrl: SERVER, username: 'u', password: 'p' })).lastInsertRowid,
  );
  db.prepare(`INSERT INTO categories (provider_id, kind, remote_id, name, position, seen_at) VALUES (?, 'live', '5', 'Misc', 0, 0)`).run(providerId);
  db.prepare(`INSERT INTO items (provider_id, kind, remote_id, name, seen_at) VALUES (?, 'live', '1', 'one', 0)`).run(providerId);
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (body: Buffer, id = providerId) =>
  app.inject({
    method: 'POST',
    url: `/api/providers/${id}/import/iptvnator`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: body,
  });
const uploadFile = (f: Parameters<typeof iptvnatorFixture>[1]) => upload(fs.readFileSync(iptvnatorFixture(dir, f)));

test('the route imports an uploaded database and deletes the temp file on success', async () => {
  const res = await uploadFile({
    categories: [{ type: 'live', xtreamId: 5, hidden: true }],
    favourites: [{ type: 'live', xtreamId: 1 }],
  });
  expect(res.statusCode).toBe(200);
  expect(res.json() as ImportResult).toEqual({ categoriesMatched: 1, hiddenApplied: 1, favouritesImported: 1 });
  expect(fs.readdirSync(spool)).toEqual([]);
});

test('the route answers 400 and 422 and deletes the temp file on failure', async () => {
  const notDb = await upload(Buffer.from('definitely not sqlite'));
  expect(notDb.statusCode).toBe(400);
  expect(notDb.json()).toMatchObject({ code: 'NOT_IPTVNATOR' });
  expect(fs.readdirSync(spool)).toEqual([]);

  const other = await uploadFile({ serverUrl: 'http://elsewhere.example' });
  expect(other.statusCode).toBe(422);
  expect(other.json()).toMatchObject({ code: 'NO_MATCHING_PLAYLIST' });
  expect(fs.readdirSync(spool)).toEqual([]);

  expect((await upload(Buffer.from('x'), 999)).statusCode).toBe(404);
  expect(fs.readdirSync(spool)).toEqual([]);
});
