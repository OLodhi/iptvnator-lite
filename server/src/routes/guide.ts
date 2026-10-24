import type { FastifyPluginAsync } from 'fastify';
import type { ApiError } from '@tv/shared';
import type { GuideRunner } from '../guide/runner.ts';
import type { ProviderService } from '../providers/service.ts';

export const guideRoutes = (deps: { guide: GuideRunner; providers: ProviderService }): FastifyPluginAsync =>
  async (app) => {
    const idSchema = { params: { type: 'object', properties: { id: { type: 'integer' } } } };
    const notFound = (id: number): ApiError => ({ code: 'NOT_FOUND', message: `Provider ${id} not found` });

    app.post<{ Params: { id: number } }>('/providers/:id/guide', { schema: idSchema }, async (req, reply) => {
      if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound(req.params.id));
      deps.guide.start(req.params.id);
      return reply.code(202).send({ started: true });
    });

    app.get<{ Params: { id: number } }>('/providers/:id/guide', { schema: idSchema }, async (req, reply) => {
      if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound(req.params.id));
      return deps.guide.status(req.params.id);
    });
  };
