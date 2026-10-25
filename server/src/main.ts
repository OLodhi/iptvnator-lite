import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createSyncRunner } from './catalogue/syncRunner.ts';
import type { SyncRunner } from './catalogue/syncRunner.ts';
import { catalogueJob, createRefreshScheduler, guideJob } from './catalogue/scheduler.ts';
import { createCatalogueRepo } from './catalogue/repo.ts';
import { createSeriesInfoCache } from './catalogue/seriesInfo.ts';
import { createPersonalService } from './personal/service.ts';
import { createCurationService } from './curation/service.ts';
import { openDb } from './db/db.ts';
import { afterSync, createGuideRunner } from './guide/runner.ts';
import { createGuideStore } from './guide/store.ts';
import { visibleLiveItemIds } from './guide/visible.ts';
import { createPrefsService } from './prefs/service.ts';
import { DEFAULT_USER_ID } from './users.ts';
import { createLogoCache } from './logos/cache.ts';
import { createProber, withProbeLog } from './playback/probe.ts';
import { startUpstreamRelay } from './playback/relay.ts';
import { createSessionManager, defaultIsReady } from './playback/sessions.ts';
import { spawnFfmpeg } from './playback/spawn.ts';
import { createProviderService, refreshLegacyAccounts } from './providers/service.ts';
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
const curation = createCurationService({ db, now: Date.now });
const guideStore = createGuideStore(db);
const guide = createGuideRunner({
  db,
  store: guideStore,
  providers,
  visibleLiveItemIds: (providerId) => visibleLiveItemIds(db, curation, providerId, DEFAULT_USER_ID),
  log,
});
sync = createSyncRunner({ db, providers, onSynced: afterSync(guide, guideStore, log), log });
const catalogue = createCatalogueRepo(db);
const seriesInfo = createSeriesInfoCache({ providers, catalogue });
const prober = createProber({ ffprobePath: config.ffprobePath, db });
const relay = await startUpstreamRelay({ log });
const sessions = createSessionManager({
  ffmpegPath: config.ffmpegPath,
  transcodeDir: config.transcodeDir,
  spawn: spawnFfmpeg(log),
  probe: withProbeLog((url, userAgent, readFrom, opts) => prober.probe(url, userAgent, readFrom, opts), log),
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
  relay,
});
const personal = createPersonalService({ db, now: Date.now });
const prefs = createPrefsService(db);
const logos = createLogoCache({
  dir: config.logoDir,
  now: Date.now,
  userAgent: config.defaultUserAgent,
  allowPrivate: config.allowPrivateImageHosts,
});
const app = await buildApp({
  config, db, providers, sync, catalogue, seriesInfo, sessions, curation, personal, guide, prefs, logos, log, httpLogLevel: 'warn',
});

const scheduler = createRefreshScheduler({
  jobs: [catalogueJob({ providers, sync }), guideJob({ providers, guide, store: guideStore })],
  now: Date.now,
  log,
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  logos.stop();
  try {
    // Together: closing the app aborts direct streams, stopAll ends every FFmpeg, and the guide refresh is aborted.
    await Promise.allSettled([app.close(), sessions.stopAll(), guide.stop()]);
    await relay.close();
  } finally {
    db.close();
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Accounts stored before the timezone field get it now, not at the next daily sync; in the background, never awaited.
void refreshLegacyAccounts({ providers, log });
await app.listen({ port: config.port, host: config.host });
scheduler.start();
logos.start();
console.log(`Server listening on http://${config.host}:${config.port}`);
