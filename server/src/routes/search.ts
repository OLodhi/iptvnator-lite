import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, Kind, SearchResults } from '@tv/shared';
import type { Presenter } from '../browse/presenter.ts';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { Search } from '../catalogue/search.ts';
import type { CurationService } from '../curation/service.ts';
import type { PersonalService } from '../personal/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { currentUserId } from '../users.ts';

const KINDS: Kind[] = ['live', 'movie', 'series'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Lower case with accents removed, so "cafe" finds "Café". */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const searchRoutes = (deps: {
  search: Search;
  presenter: Presenter;
  catalogue: CatalogueRepo;
  curation: CurationService;
  personal: PersonalService;
  providers: ProviderService;
}): FastifyPluginAsync =>
  async (app) => {
    app.setErrorHandler((err: Error, _req, reply) => {
      if ((err as { validation?: unknown }).validation) {
        return reply.code(400).send({ code: 'VALIDATION', message: err.message } satisfies ApiError);
      }
      throw err;
    });

    app.get<{ Querystring: { q?: string; limit?: number } }>(
      '/search',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { q: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
          },
        },
      },
      async (req): Promise<SearchResults> => {
        const userId = currentUserId(req);
        const q = (req.query.q ?? '').trim();
        const limit = Math.min(req.query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
        const results: SearchResults = { live: [], movie: [], series: [], categories: [] };
        const provider = deps.providers.list()[0];
        if (!provider || q === '') return results;

        const needle = fold(q);
        for (const kind of KINDS) {
          const resolution = deps.curation.resolution(provider.id, kind, userId);
          const { visibleIds, allVisible, displayName } = resolution;
          const favourites = new Set(deps.personal.favouriteItemIds(userId, provider.id, kind));
          const found = deps.search.items(provider.id, kind, q, allVisible ? 'all' : visibleIds, limit);
          results[kind] = deps.presenter.itemsWith(resolution, favourites, found);
          const pinned = new Set(deps.personal.pinnedCategoryIds(userId, provider.id, kind));
          for (const c of deps.catalogue.listCategories(provider.id, kind)) {
            const name = displayName(c.name);
            if (visibleIds.has(c.id) && fold(name).includes(needle)) {
              results.categories.push({ id: c.id, kind, displayName: name, itemCount: c.itemCount, pinned: pinned.has(c.id) });
            }
          }
        }
        results.categories.length = Math.min(results.categories.length, limit);
        return results;
      },
    );
  };
