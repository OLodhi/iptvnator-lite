import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, Kind } from '@tv/shared';
import type { Presenter } from '../browse/presenter.ts';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { currentUserId } from '../users.ts';
import { ProviderError } from '../providers/errors.ts';
import type { ProviderService } from '../providers/service.ts';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const idParams = { type: 'object', properties: { id: { type: 'integer' } } };

export const catalogueRoutes = (deps: {
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
  providers: ProviderService;
  presenter: Presenter;
}): FastifyPluginAsync =>
  async (app) => {
    const notFound = (what: string, id: number): ApiError => ({ code: 'NOT_FOUND', message: `${what} ${id} not found` });

    app.setErrorHandler((err: Error, _req, reply) => {
      if (err instanceof ProviderError) {
        const body: ApiError = { code: err.code, message: err.message };
        return reply.code(422).send(body);
      }
      if ((err as { validation?: unknown }).validation) {
        const body: ApiError = { code: 'VALIDATION', message: err.message };
        return reply.code(400).send(body);
      }
      throw err;
    });

    app.get<{ Params: { id: number }; Querystring: { kind: Kind } }>(
      '/providers/:id/categories',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            required: ['kind'],
            properties: { kind: { enum: ['live', 'movie', 'series'] } },
          },
        },
      },
      async (req, reply) => {
        if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound('Provider', req.params.id));
        return deps.catalogue.listCategories(req.params.id, req.query.kind);
      },
    );

    app.get<{ Params: { id: number }; Querystring: { cursor?: string; limit?: number } }>(
      '/categories/:id/items',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
          },
        },
      },
      async (req, reply) => {
        const limit = Math.min(req.query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
        const page = deps.catalogue.listItems(req.params.id, req.query.cursor ?? null, limit);
        if (!page) return reply.code(400).send({ code: 'VALIDATION', message: 'Invalid cursor' } satisfies ApiError);
        return { items: deps.presenter.items(page.items, currentUserId(req)), nextCursor: page.nextCursor };
      },
    );

    app.get<{ Params: { id: number } }>('/items/:id', { schema: { params: idParams } }, async (req, reply) => {
      const item = deps.catalogue.getItem(req.params.id);
      if (!item) return reply.code(404).send(notFound('Item', req.params.id));
      return deps.presenter.items([item], currentUserId(req))[0];
    });

    app.get<{ Params: { id: number } }>('/items/:id/seasons', { schema: { params: idParams } }, async (req, reply) => {
      const item = deps.catalogue.getItem(req.params.id);
      if (!item || item.kind !== 'series') return reply.code(404).send(notFound('Series', req.params.id));
      return deps.seriesInfo.getSeasons(item.id);
    });
  };
