import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, PositionReport } from '@tv/shared';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import type { PersonalService } from '../personal/service.ts';
import { currentUserId } from '../users.ts';

const idParams = (name: string) => ({ type: 'object', properties: { [name]: { type: 'integer' } } });
const idBody = (name: string) => ({ type: 'object', required: [name], properties: { [name]: { type: 'integer' } } });
const positionBody = {
  type: 'object',
  required: ['itemId', 'positionSec', 'durationSec'],
  properties: {
    itemId: { type: 'integer' },
    episodeRemoteId: { type: 'string', minLength: 1 },
    positionSec: { type: 'number', minimum: 0 },
    durationSec: { type: ['number', 'null'], minimum: 0 },
  },
  additionalProperties: false,
};

const watchedBody = {
  type: 'object',
  required: ['itemId', 'episodeRemoteIds', 'watched'],
  properties: {
    itemId: { type: 'integer' },
    episodeRemoteIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 500, uniqueItems: true },
    watched: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const meRoutes = (deps: {
  personal: PersonalService;
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
}): FastifyPluginAsync =>
  async (app) => {
    const { personal, catalogue } = deps;
    const notFound = (what: string, id: number | string): ApiError => ({ code: 'NOT_FOUND', message: `${what} ${id} not found` });

    app.setErrorHandler((err: Error, _req, reply) => {
      if ((err as { validation?: unknown }).validation) {
        return reply.code(400).send({ code: 'VALIDATION', message: err.message } satisfies ApiError);
      }
      throw err;
    });

    app.post<{ Body: { categoryId: number } }>('/me/pins', { schema: { body: idBody('categoryId') } }, async (req, reply) => {
      if (!personal.pin(currentUserId(req), req.body.categoryId)) return reply.code(404).send(notFound('Category', req.body.categoryId));
      return reply.code(204).send();
    });
    app.delete<{ Params: { categoryId: number } }>(
      '/me/pins/:categoryId',
      { schema: { params: idParams('categoryId') } },
      async (req, reply) => {
        if (!personal.unpin(currentUserId(req), req.params.categoryId)) return reply.code(404).send(notFound('Category', req.params.categoryId));
        return reply.code(204).send();
      },
    );

    app.post<{ Body: { itemId: number } }>('/me/favourites', { schema: { body: idBody('itemId') } }, async (req, reply) => {
      if (!personal.addFavourite(currentUserId(req), req.body.itemId)) return reply.code(404).send(notFound('Item', req.body.itemId));
      return reply.code(204).send();
    });
    app.delete<{ Params: { itemId: number } }>(
      '/me/favourites/:itemId',
      { schema: { params: idParams('itemId') } },
      async (req, reply) => {
        if (!personal.removeFavourite(currentUserId(req), req.params.itemId)) return reply.code(404).send(notFound('Item', req.params.itemId));
        return reply.code(204).send();
      },
    );

    app.put<{ Body: PositionReport }>('/me/positions', { schema: { body: positionBody } }, async (req, reply) => {
      const { itemId, episodeRemoteId } = req.body;
      const item = catalogue.getItem(itemId);
      if (!item) return reply.code(404).send(notFound('Item', itemId));
      if (episodeRemoteId === undefined ? item.kind !== 'movie' : item.kind !== 'series') {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: 'Positions are kept for movies, and for episodes of a series',
        } satisfies ApiError);
      }
      let label: string | undefined;
      if (episodeRemoteId !== undefined) {
        const episode = await deps.seriesInfo.getEpisode(itemId, episodeRemoteId);
        if (!episode) return reply.code(404).send(notFound('Episode', episodeRemoteId));
        label = `S${episode.season} E${episode.episodeNum}`;
      }
      personal.savePosition(currentUserId(req), req.body, label);
      return reply.code(204).send();
    });
    app.put<{ Body: { itemId: number; episodeRemoteIds: string[]; watched: boolean } }>(
      '/me/watched',
      { schema: { body: watchedBody } },
      async (req, reply) => {
        const { itemId, episodeRemoteIds, watched } = req.body;
        const item = catalogue.getItem(itemId);
        if (!item) return reply.code(404).send(notFound('Item', itemId));
        if (item.kind !== 'series') {
          return reply.code(400).send({ code: 'VALIDATION', message: 'Only episodes of a series can be marked watched' } satisfies ApiError);
        }
        const known = new Map<string, { label: string; durationSec: number | null }>();
        for (const season of (await deps.seriesInfo.getDetails(itemId)).seasons) {
          for (const e of season.episodes) known.set(e.remoteId, { label: `S${season.season} E${e.episodeNum}`, durationSec: e.durationSec });
        }
        const episodes = [];
        for (const remoteId of episodeRemoteIds) {
          const e = known.get(remoteId);
          if (!e) return reply.code(404).send(notFound('Episode', remoteId));
          episodes.push({ remoteId, ...e });
        }
        personal.markWatched(currentUserId(req), itemId, episodes, watched);
        return reply.code(204).send();
      },
    );
    app.get<{ Params: { itemId: number } }>(
      '/me/positions/:itemId',
      { schema: { params: idParams('itemId') } },
      async (req, reply) => {
        if (!catalogue.getItem(req.params.itemId)) return reply.code(404).send(notFound('Item', req.params.itemId));
        return personal.positions(currentUserId(req), req.params.itemId);
      },
    );
  };
