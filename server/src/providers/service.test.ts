import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { openDb } from '../db/db.ts';
import { resolveSourceUrl } from '../playback/sourceUrl.ts';
import type { Log } from '../util/log.ts';
import { createProviderService, refreshLegacyAccounts } from './service.ts';
import type { ProviderService } from './service.ts';
import { createXtreamClient } from './xtream/client.ts';
import type { XtreamClient } from './xtream/client.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
// An account as stored before Plan 3: no timezone key at all.
const LEGACY = { status: 'Active', maxConnections: 1, expiresAt: null, allowedOutputFormats: [] };

function recordingLog() {
  const lines: { level: string; o: object; msg: string }[] = [];
  const log: Log = {
    info: (o, msg) => void lines.push({ level: 'info', o, msg }),
    warn: (o, msg) => void lines.push({ level: 'warn', o, msg }),
  };
  return { log, lines };
}

let fake: FakeXtream;
beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), timezone: 'Europe/Amsterdam' });
});
afterAll(async () => {
  await fake.close();
});

test('an account stored without a timezone reads back with timezone null', async () => {
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: 'ua' });
  const id = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify(LEGACY), id);
  expect(providers.account(id)?.timezone).toBeNull();
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

test('at boot, an account stored without the timezone key is refreshed, and catch-up then uses the provider zone', async () => {
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: 'ua' });
  const id = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(id), providerId: id, kinds: ['live'] });
  db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify(LEGACY), id);

  const catalogue = createCatalogueRepo(db);
  const programme = Date.UTC(2026, 9, 25, 20, 0) / 1000; // 21:00 in Amsterdam, on winter time
  const deps = { catalogue, seriesInfo: createSeriesInfoCache({ providers, catalogue }), providers, now: () => (programme + 1800) * 1000 };
  const itemId = db.prepare("SELECT id FROM items WHERE provider_id = ? AND kind = 'live' AND remote_id = '1'").pluck().get(id) as number;
  const catchupUrl = async () =>
    (await resolveSourceUrl(deps, { itemId, clientId: 'A', catchup: { startSec: programme, stopSec: programme + 3600 } })).sourceUrl;
  expect(await catchupUrl()).toContain('/2026-10-25:20-00/'); // read as UTC

  const { log, lines } = recordingLog();
  await refreshLegacyAccounts({ providers, log });
  expect(providers.account(id)?.timezone).toBe('Europe/Amsterdam');
  expect(await catchupUrl()).toContain('/2026-10-25:21-00/');
  expect(lines).toEqual([{ level: 'info', o: { providerId: id, timezone: 'Europe/Amsterdam' }, msg: 'account refreshed' }]);
});

test('at boot, only accounts missing the timezone key are refreshed, not one that stores none', async () => {
  const db = openDb(':memory:');
  let logins = 0;
  const providers = createProviderService({
    db,
    userAgent: 'ua',
    makeClient: (creds, opts) => {
      const client = createXtreamClient(creds, opts);
      return {
        ...client,
        authenticate: () => {
          logins++;
          return client.authenticate();
        },
      };
    },
  });
  const add = async () => (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  const [legacy, none, named] = [await add(), await add(), await add()];
  db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify(LEGACY), legacy);
  db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify({ ...LEGACY, timezone: null }), none);
  logins = 0;

  await refreshLegacyAccounts({ providers, log: recordingLog().log });
  expect(logins).toBe(1);
  expect(providers.account(legacy)?.timezone).toBe('Europe/Amsterdam');
  expect(providers.account(none)?.timezone).toBeNull();
  expect(providers.account(named)?.timezone).toBe('Europe/Amsterdam');

  // Once refreshed, a later boot leaves it alone too.
  await refreshLegacyAccounts({ providers, log: recordingLog().log });
  expect(logins).toBe(1);
});

test('a failed refresh at boot is logged redacted, keeps the stored account, and never rejects', async () => {
  const db = openDb(':memory:');
  const id = (await createProviderService({ db, userAgent: 'ua' }).add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify(LEGACY), id);
  const leak = 'connect failed: http://host/player_api.php?username=alice&password=hunter2';
  const providers = createProviderService({
    db,
    userAgent: 'ua',
    makeClient: () => ({ authenticate: () => Promise.reject(new Error(leak)) }) as unknown as XtreamClient,
  });

  const { log, lines } = recordingLog();
  await expect(refreshLegacyAccounts({ providers, log })).resolves.toBeUndefined();
  expect(lines).toEqual([
    { level: 'warn', o: { providerId: id, err: expect.stringContaining('connect failed') }, msg: 'account refresh failed' },
  ]);
  expect(JSON.stringify(lines)).not.toMatch(/alice|hunter2/);
  expect(providers.account(id)).toEqual({ ...LEGACY, timezone: null });

  // Even a failure to list the accounts is only logged.
  const broken = { ...providers, withoutTimezone: () => { throw new Error(leak); } } as ProviderService;
  const second = recordingLog();
  await expect(refreshLegacyAccounts({ providers: broken, log: second.log })).resolves.toBeUndefined();
  expect(second.lines).toEqual([{ level: 'warn', o: { err: expect.stringContaining('connect failed') }, msg: 'account refresh failed' }]);
  expect(JSON.stringify(second.lines)).not.toMatch(/alice|hunter2/);
});
