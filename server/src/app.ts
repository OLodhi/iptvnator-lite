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
import { catalogueRoutes } from './routes/catalogue.ts';
import { providerRoutes } from './routes/providers.ts';
import { syncRoutes } from './routes/sync.ts';

export type AppDeps = { config: Config; db: Db; providers: ProviderService; sync: SyncRunner;
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({ logger: false });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(providerRoutes(deps.providers));
      await api.register(
        catalogueRoutes({ catalogue: deps.catalogue, seriesInfo: deps.seriesInfo, providers: deps.providers }),
      );
      await api.register(syncRoutes({ sync: deps.sync, providers: deps.providers }));
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
