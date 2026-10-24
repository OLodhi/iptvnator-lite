import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, CurationUpdate, Kind } from '@tv/shared';
import type { CurationService } from '../curation/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { currentUserId } from '../users.ts';

const curationParams = {
  type: 'object',
  properties: { id: { type: 'integer' }, kind: { enum: ['live', 'movie', 'series'] } },
};
const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
// An enum rather than `type: 'boolean'`: Fastify's Ajv would quietly coerce 'true', 1 and null into booleans.
const choices = { type: 'object', additionalProperties: { enum: [true, false] } };
const updateBody = {
  type: 'object',
  required: ['tags', 'categories'],
  properties: { tags: choices, categories: choices },
  additionalProperties: false,
};

export const curationRoutes = (deps: { curation: CurationService; providers: ProviderService }): FastifyPluginAsync =>
  async (app) => {
    const notFound = (what: string, id: number): ApiError => ({ code: 'NOT_FOUND', message: `${what} ${id} not found` });

    app.setErrorHandler((err: Error, _req, reply) => {
      if ((err as { validation?: unknown }).validation) {
        const body: ApiError = { code: 'VALIDATION', message: err.message };
        return reply.code(400).send(body);
      }
      throw err;
    });

    app.get<{ Params: { id: number; kind: Kind } }>(
      '/providers/:id/curation/:kind',
      { schema: { params: curationParams } },
      async (req, reply) => {
        if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound('Provider', req.params.id));
        return deps.curation.view(req.params.id, req.params.kind, currentUserId(req));
      },
    );

    // Writes go to the default rules: the owner is the admin until accounts arrive (Plan 4).
    app.put<{ Params: { id: number; kind: Kind }; Body: CurationUpdate }>(
      '/providers/:id/curation/:kind',
      { schema: { params: curationParams, body: updateBody } },
      async (req, reply) => {
        if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound('Provider', req.params.id));
        deps.curation.save(req.params.id, req.params.kind, req.body, null);
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: number } }>('/categories/:id/hide', { schema: { params: idParams } }, async (req, reply) => {
      if (!deps.curation.hideCategory(req.params.id, null)) return reply.code(404).send(notFound('Category', req.params.id));
      return reply.code(204).send();
    });
  };
