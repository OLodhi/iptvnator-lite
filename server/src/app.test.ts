import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { buildApp } from './app.ts';
import { createSyncRunner } from './catalogue/syncRunner.ts';
import { createCatalogueRepo } from './catalogue/repo.ts';
import { createSeriesInfoCache } from './catalogue/seriesInfo.ts';
import { openDb } from './db/db.ts';
import { createProviderService } from './providers/service.ts';
import { testConfig } from './testing/config.ts';
import { stubSessions } from './testing/sessions.ts';

async function appFor(webDir: string) {
  const db = openDb(':memory:');
  const config = testConfig({ webDir });
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  const catalogue = createCatalogueRepo(db);
  return buildApp({
    config, db, providers, catalogue,
    sync: createSyncRunner({ db, providers }),
    seriesInfo: createSeriesInfoCache({ providers, catalogue }),
    sessions: stubSessions(),
  });
}

function webDirWithIndex(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><!--spa--></html>');
  return dir;
}

test('GET /api/health returns ok', async () => {
  const app = await appFor(webDirWithIndex());
  const res = await app.inject('/api/health');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test('non-API paths serve the SPA index', async () => {
  const app = await appFor(webDirWithIndex());
  const res = await app.inject('/browse/live/12');
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<!--spa-->');
});

test('unknown API paths return a JSON 404', async () => {
  const app = await appFor(webDirWithIndex());
  const res = await app.inject('/api/nope');
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
});
