import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createSyncRunner } from './catalogue/syncRunner.ts';
import type { SyncRunner } from './catalogue/syncRunner.ts';
import { createCatalogueRepo } from './catalogue/repo.ts';
import { createSeriesInfoCache } from './catalogue/seriesInfo.ts';
import { openDb } from './db/db.ts';
import { createProviderService } from './providers/service.ts';

const config = loadConfig(process.env);
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(path.join(config.dataDir, 'tv.sqlite'));
// The provider service is created before the runner exists, so onAdded late-binds it.
let sync: SyncRunner | undefined;
const providers = createProviderService({
  db,
  userAgent: config.defaultUserAgent,
  onAdded: (id) => sync?.start(id),
});
sync = createSyncRunner({ db, providers });
const catalogue = createCatalogueRepo(db);
const seriesInfo = createSeriesInfoCache({ providers, catalogue });
const app = await buildApp({ config, db, providers, sync, catalogue, seriesInfo });

async function shutdown(): Promise<void> {
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
console.log(`Server listening on http://${config.host}:${config.port}`);
