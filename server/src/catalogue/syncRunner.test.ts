import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { createSyncRunner } from './syncRunner.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

let fake: FakeXtream;
beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), timezone: 'Europe/Amsterdam' });
});
afterAll(async () => {
  await fake.close();
});

async function settled(runner: ReturnType<typeof createSyncRunner>, id: number) {
  for (let i = 0; i < 200 && runner.status(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
  return runner.status(id);
}

test('sync refreshes the account first and survives a refresh failure', async () => {
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: 'ua' });
  const id = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  const stale = { status: 'Stale', maxConnections: 9, expiresAt: null, allowedOutputFormats: [], timezone: null };
  db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify(stale), id);

  const runner = createSyncRunner({ db, providers });
  runner.start(id);
  expect((await settled(runner, id)).state).toBe('idle');
  expect(providers.account(id)).toMatchObject({ status: 'Active', timezone: 'Europe/Amsterdam' });

  // A failing refresh is logged and the sync goes on with the stored account.
  const warnings: string[] = [];
  const failing: typeof providers = {
    ...providers,
    refreshAccount: async () => {
      throw new Error('refresh down');
    },
  };
  const runner2 = createSyncRunner({ db, providers: failing, log: { info() {}, warn: (_o, msg) => void warnings.push(msg) } });
  runner2.start(id);
  expect((await settled(runner2, id)).state).toBe('idle');
  expect(warnings).toContain('account refresh failed');
});
