import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from './service.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

let fake: FakeXtream;
beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), timezone: 'Europe/Amsterdam' });
});
afterAll(async () => {
  await fake.close();
});

test('refreshAccount stores the new account', async () => {
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: 'ua' });
  const id = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  const stale = { status: 'Stale', maxConnections: 9, expiresAt: null, allowedOutputFormats: [] };
  db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify(stale), id);
  const fresh = await providers.refreshAccount(id);
  expect(fresh).toMatchObject({ status: 'Active', maxConnections: 1, timezone: 'Europe/Amsterdam' });
  expect(providers.account(id)).toEqual(fresh);
});
