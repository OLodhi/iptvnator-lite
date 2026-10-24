import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, BrowseView, Kind } from '@tv/shared';
import type { Presenter } from '../browse/presenter.ts';
import type { ProviderService } from '../providers/service.ts';
import { currentUserId } from '../users.ts';

export const browseRoutes = (deps: { presenter: Presenter; providers: ProviderService }): FastifyPluginAsync =>
  async (app) => {
    app.setErrorHandler((err: Error, _req, reply) => {
      if ((err as { validation?: unknown }).validation) {
        return reply.code(400).send({ code: 'VALIDATION', message: err.message } satisfies ApiError);
      }
      throw err;
    });

    app.get<{ Params: { kind: Kind } }>(
      '/me/browse/:kind',
      {
        schema: {
          params: { type: 'object', properties: { kind: { enum: ['live', 'movie', 'series'] } } },
        },
      },
      async (req): Promise<BrowseView> => {
        const { kind } = req.params;
        // Until there are several providers to choose between, browsing is of the first one.
        const provider = deps.providers.list()[0];
        if (!provider) {
          return {
            providerId: null, kind, categories: [], pinned: [], recent: [], favourites: [], continueWatching: [], newCategories: 0,
          };
        }
        return deps.presenter.browse(currentUserId(req), provider.id, kind);
      },
    );
  };
