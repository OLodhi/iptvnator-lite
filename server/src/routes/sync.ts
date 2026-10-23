import type { FastifyPluginAsync } from 'fastify';
import type { ApiError } from '@tv/shared';
import type { SyncRunner } from '../catalogue/syncRunner.ts';
import type { ProviderService } from '../providers/service.ts';

export const syncRoutes = (deps: { sync: SyncRunner; providers: ProviderService }): FastifyPluginAsync =>
  async (app) => {
    const idSchema = { params: { type: 'object', properties: { id: { type: 'integer' } } } };
    const notFound = (id: number): ApiError => ({ code: 'NOT_FOUND', message: `Provider ${id} not found` });

    app.post<{ Params: { id: number } }>('/providers/:id/sync', { schema: idSchema }, async (req, reply) => {
      if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound(req.params.id));
      deps.sync.start(req.params.id);
      return reply.code(202).send({ started: true });
    });

    app.get<{ Params: { id: number } }>('/providers/:id/sync', { schema: idSchema }, async (req, reply) => {
      if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound(req.params.id));
      return deps.sync.status(req.params.id);
    });
  };
