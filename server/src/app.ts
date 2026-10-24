import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ApiError } from '@tv/shared';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import type { ProviderService } from './providers/service.ts';
import { healthRoutes } from './routes/health.ts';
import type { SyncRunner } from './catalogue/syncRunner.ts';
import type { CatalogueRepo } from './catalogue/repo.ts';
import type { SeriesInfoCache } from './catalogue/seriesInfo.ts';
import type { SessionManager } from './playback/sessions.ts';
import type { CurationService } from './curation/service.ts';
import { createPresenter } from './browse/presenter.ts';
import { createSearch } from './catalogue/search.ts';
import { browseRoutes } from './routes/browse.ts';
import { searchRoutes } from './routes/search.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { curationRoutes } from './routes/curation.ts';
import type { PersonalService } from './personal/service.ts';
import { meRoutes } from './routes/me.ts';
import { playbackRoutes } from './routes/playback.ts';
import { providerRoutes } from './routes/providers.ts';
import { syncRoutes } from './routes/sync.ts';
import { silentLog } from './util/log.ts';
import type { Log } from './util/log.ts';

export type AppDeps = {
  config: Config;
  db: Db;
  providers: ProviderService;
  sync: SyncRunner;
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
  sessions: SessionManager;
  curation: CurationService;
  personal: PersonalService;
  /** The server's own log (provider failures, sessions); silent if left out. */
  log?: Log;
  /** Turns on Fastify's request/error log at this level; off if left out (as in tests). */
  httpLogLevel?: 'error' | 'warn' | 'info';
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const presenter = createPresenter(deps);
  const search = createSearch(deps.db);
  const app = Fastify({ logger: deps.httpLogLevel ? { level: deps.httpLogLevel } : false });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(providerRoutes(deps.providers));
      await api.register(
        catalogueRoutes({ catalogue: deps.catalogue, seriesInfo: deps.seriesInfo, providers: deps.providers, presenter }),
      );
      await api.register(syncRoutes({ sync: deps.sync, providers: deps.providers }));
      await api.register(curationRoutes({ curation: deps.curation, providers: deps.providers }));
      await api.register(
        meRoutes({ personal: deps.personal, catalogue: deps.catalogue, seriesInfo: deps.seriesInfo }),
      );
      await api.register(browseRoutes({ presenter, providers: deps.providers }));
      await api.register(
        searchRoutes({
          search, presenter, catalogue: deps.catalogue, curation: deps.curation, personal: deps.personal, providers: deps.providers,
        }),
      );
      await api.register(
        playbackRoutes({
          catalogue: deps.catalogue,
          seriesInfo: deps.seriesInfo,
          providers: deps.providers,
          sessions: deps.sessions,
          personal: deps.personal,
          log: deps.log ?? silentLog,
          userAgent: config.defaultUserAgent,
        }),
      );
    },
    { prefix: '/api' },
  );

  const indexPath = path.join(config.webDir, 'index.html');
  const hasWeb = fs.existsSync(indexPath);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDir) });
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/api?');
    if (isApi || !hasWeb || (req.method !== 'GET' && req.method !== 'HEAD')) {
      const body: ApiError = { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url.split('?')[0]} not found` };
      return reply.code(404).send(body);
    }
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(indexPath));
  });

  return app;
}
