import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { MAX_CATCHUP_SEC, resolveSourceUrl, SourceError } from './sourceUrl.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const NOW_MS = Date.UTC(2026, 6, 1, 20, 30);
const NOW_SEC = NOW_MS / 1000;
const PROGRAMME = Date.UTC(2026, 6, 1, 18, 0) / 1000; // 19:00 in London (BST)

let fake: FakeXtream;
let deps: Parameters<typeof resolveSourceUrl>[0];
let liveItem: (remoteId: number) => number;

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), now: () => NOW_MS }); // Europe/London
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: 'ua' });
  const providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
  const catalogue = createCatalogueRepo(db);
  deps = { catalogue, seriesInfo: createSeriesInfoCache({ providers, catalogue }), providers, now: () => NOW_MS };
  const lookup = db.prepare("SELECT id FROM items WHERE provider_id = ? AND kind = 'live' AND remote_id = ?").pluck();
  liveItem = (remoteId) => lookup.get(providerId, String(remoteId)) as number;
});

afterAll(async () => {
  await fake?.close();
});

const catchupOn = (remoteId: number, startSec: number, stopSec: number) =>
  resolveSourceUrl(deps, { itemId: liveItem(remoteId), clientId: 'A', catchup: { startSec, stopSec } });

describe('resolveSourceUrl catch-up', () => {
  test('builds a timeshift URL in the provider timezone', async () => {
    const source = await catchupOn(1, PROGRAMME, PROGRAMME + 3600);
    expect(source).toStrictEqual({
      providerId: expect.any(Number),
      kind: 'catchup',
      contentKey: `catchup:1:${PROGRAMME}`,
      sourceUrl: expect.stringMatching(/\/timeshift\/u\/p\/60\/2026-07-01:19-00\/1\.ts$/),
      durationHintSec: 3600,
    });
  });

  test('rejects catch-up on a channel without archive, too old, not started, too long, or stop before start', async () => {
    const archiveStart = NOW_SEC - 2 * 86_400 - 60; // live 1 keeps 2 days, with a minute's grace
    const cases: [string, number, number, number][] = [
      ['no archive', 2, PROGRAMME, PROGRAMME + 3600],
      ['too old', 1, archiveStart - 1, archiveStart + 3600],
      ['not started', 1, NOW_SEC, NOW_SEC + 3600],
      ['too long', 1, PROGRAMME, PROGRAMME + MAX_CATCHUP_SEC + 1],
      ['stop before start', 1, PROGRAMME, PROGRAMME],
    ];
    for (const [name, remoteId, startSec, stopSec] of cases) {
      const err: unknown = await catchupOn(remoteId, startSec, stopSec).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(SourceError);
      expect((err as SourceError).code, name).toBe('VALIDATION');
    }
    await expect(catchupOn(2, PROGRAMME, PROGRAMME + 3600)).rejects.toThrow("This channel doesn't support catch-up");
  });

  test('accepts catch-up at the edges of the archive and the length limit', async () => {
    const archiveStart = NOW_SEC - 2 * 86_400 - 60;
    expect((await catchupOn(1, archiveStart, archiveStart + 3600)).kind).toBe('catchup');
    expect((await catchupOn(1, NOW_SEC - 1, NOW_SEC + 3600)).kind).toBe('catchup'); // airing now
    expect((await catchupOn(1, PROGRAMME, PROGRAMME + MAX_CATCHUP_SEC)).durationHintSec).toBe(MAX_CATCHUP_SEC);
  });

  test('asks for m3u8 only when the provider allows m3u8 but not ts', async () => {
    const withFormats = (allowedOutputFormats: string[]): Parameters<typeof resolveSourceUrl>[0] => ({
      ...deps,
      providers: { ...deps.providers, account: (id) => ({ ...deps.providers.account(id)!, allowedOutputFormats }) } as ProviderService,
    });
    const req = { itemId: liveItem(1), clientId: 'A', catchup: { startSec: PROGRAMME, stopSec: PROGRAMME + 3600 } };
    const ext = async (formats: string[]) => (await resolveSourceUrl(withFormats(formats), req)).sourceUrl.split('.').pop();
    expect(await ext(['m3u8'])).toBe('m3u8');
    expect(await ext(['m3u8', 'ts'])).toBe('ts');
    expect(await ext(['rtmp'])).toBe('ts');
    expect(await ext([])).toBe('ts');
  });
});
