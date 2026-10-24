import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createSyncRunner } from './catalogue/syncRunner.ts';
import type { SyncRunner } from './catalogue/syncRunner.ts';
import { createRefreshScheduler } from './catalogue/scheduler.ts';
import { createCatalogueRepo } from './catalogue/repo.ts';
import { createSeriesInfoCache } from './catalogue/seriesInfo.ts';
import { createPersonalService } from './personal/service.ts';
import { createCurationService } from './curation/service.ts';
import { openDb } from './db/db.ts';
import { createLogoCache } from './logos/cache.ts';
import { createProber, withProbeLog } from './playback/probe.ts';
import { createSessionManager, defaultIsReady } from './playback/sessions.ts';
import { spawnFfmpeg } from './playback/spawn.ts';
import { createProviderService } from './providers/service.ts';
import { consoleLog } from './util/log.ts';

const log = consoleLog();

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
sync = createSyncRunner({ db, providers, log });
const catalogue = createCatalogueRepo(db);
const seriesInfo = createSeriesInfoCache({ providers, catalogue });
const prober = createProber({ ffprobePath: config.ffprobePath, db });
const sessions = createSessionManager({
  ffmpegPath: config.ffmpegPath,
  transcodeDir: config.transcodeDir,
  spawn: spawnFfmpeg(log),
  probe: withProbeLog((url, userAgent) => prober.probe(url, userAgent), log),
  invalidateProbe: (url) => prober.invalidate(url),
  transcodeInterlaced: config.transcodeInterlaced,
  maxConnections: (id) => providers.account(id)?.maxConnections ?? null,
  isReady: defaultIsReady,
  now: Date.now,
  liveIdleMs: 20_000,
  vodIdleMs: 60_000,
  readyTimeoutMs: 15_000,
  stallTimeoutMs: 20_000,
  maxRestarts: 3,
  log,
});
const curation = createCurationService({ db, now: Date.now });
const personal = createPersonalService({ db, now: Date.now });
const logos = createLogoCache({ dir: config.logoDir, now: Date.now, userAgent: config.defaultUserAgent });
const app = await buildApp({
  config, db, providers, sync, catalogue, seriesInfo, sessions, curation, personal, logos, log, httpLogLevel: 'warn',
});

const scheduler = createRefreshScheduler({ providers, sync, now: Date.now });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  logos.stop();
  try {
    // Together: closing the app aborts direct streams, and stopAll ends every FFmpeg.
    await Promise.allSettled([app.close(), sessions.stopAll()]);
  } finally {
    db.close();
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
scheduler.start();
logos.start();
console.log(`Server listening on http://${config.host}:${config.port}`);
