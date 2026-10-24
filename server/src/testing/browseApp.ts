import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { FakeCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { buildApp } from '../app.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { createCurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createPersonalService } from '../personal/service.ts';
import { createProviderService } from '../providers/service.ts';
import { testConfig } from './config.ts';
import { guideDeps } from './guideDeps.ts';
import { stubSessions } from './sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

/** An app over an in-memory database synced from a fake provider serving `catalogue`. */
export async function startBrowseApp(catalogue: FakeCatalogue) {
  const fake = await startFakeXtream({ mediaDir, catalogue });
  const db: Db = openDb(':memory:');
  const config = testConfig();
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  const repo = createCatalogueRepo(db);
  const seriesInfo = createSeriesInfoCache({ providers, catalogue: repo });
  const curation = createCurationService({ db, now: Date.now });
  const personal = createPersonalService({ db, now: Date.now });
  const app: FastifyInstance = await buildApp({
    config, db, providers, catalogue: repo, curation, personal, seriesInfo,
    sync: createSyncRunner({ db, providers }),
    sessions: stubSessions(),
    ...guideDeps(db, providers),
  });
  const providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
  return {
    app, db, fake, providers, providerId, catalogue: repo, curation, personal, seriesInfo,
    close: async () => {
      await app.close();
      await fake.close();
    },
  };
}
