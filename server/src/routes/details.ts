import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, ItemDetails, SeasonDetail, WatchContext } from '@tv/shared';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import type { VodInfoCache } from '../catalogue/vodInfo.ts';
import type { CurationService } from '../curation/service.ts';
import type { Db } from '../db/db.ts';
import { ART_SLOT, artPath, providerArtUrl } from '../logos/art.ts';
import { LogoBusyError, type LogoCache } from '../logos/cache.ts';
import { ProviderError } from '../providers/errors.ts';
import { currentUserId } from '../users.ts';
import { LOGO_MAX_AGE_SECONDS } from './logos.ts';

/** As long as the cache remembers a failed fetch. */
const MISSING_MAX_AGE_SECONDS = 3600;
const idParams = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } };

const yearOf = (releaseDate: string | null): number | null => {
  const m = /^(\d{4})/.exec(releaseDate ?? '');
  return m ? Number(m[1]) : null;
};

export type DetailsRouteDeps = {
  db: Db;
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
  vodInfo: VodInfoCache;
  curation: CurationService;
  art: LogoCache;
};

export const detailsRoutes = (deps: DetailsRouteDeps): FastifyPluginAsync => async (app) => {
  const notFound = (what: string): ApiError => ({ code: 'NOT_FOUND', message: `${what} not found` });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProviderError) {
      return reply.code(502).send({ code: err.code, message: err.message } satisfies ApiError);
    }
    return reply.send(err);
  });

  app.get<{ Params: { id: number } }>('/items/:id/details', { schema: { params: idParams } }, async (req, reply) => {
    const item = deps.catalogue.getItem(req.params.id);
    if (!item || item.kind === 'live') return reply.code(404).send(notFound('Series or movie'));
    const id = item.id;
    const art = (slot: string, url: string | null) => (url ? artPath(id, slot) : null);
    if (item.kind === 'series') {
      const d = await deps.seriesInfo.getDetails(id);
      const seasons: SeasonDetail[] = d.seasons.map((s) => ({
        season: s.season,
        name: s.name,
        coverUrl: art(`season-${s.season}`, d.seasonMeta[s.season]?.coverUrl ?? null),
        episodes: s.episodes.map((e) => ({
          remoteId: e.remoteId,
          title: e.title,
          episodeNum: e.episodeNum,
          durationSec: e.durationSec,
          imageUrl: art(`episode-${e.remoteId}`, e.imageUrl),
          airDate: e.airDate,
          quality: e.quality,
        })),
      }));
      return {
        kind: 'series',
        plot: d.meta.plot,
        genre: d.meta.genre,
        cast: d.meta.cast,
        director: d.meta.director,
        year: item.year ?? yearOf(d.meta.releaseDate),
        rating: d.meta.rating,
        posterUrl: art('poster', d.meta.coverUrl),
        backdropUrl: art('backdrop', d.meta.backdropUrls[0] ?? null),
        seasons,
      } satisfies ItemDetails;
    }
    const v = await deps.vodInfo.getDetails(id);
    return {
      kind: 'movie',
      plot: v?.plot ?? null,
      genre: v?.genre ?? null,
      cast: v?.cast ?? null,
      director: v?.director ?? null,
      year: item.year ?? yearOf(v?.releaseDate ?? null),
      rating: v?.rating ?? null,
      posterUrl: art('poster', v?.coverUrl ?? null),
      backdropUrl: art('backdrop', v?.backdropUrls[0] ?? null),
      durationSec: v?.durationSec ?? null,
    } satisfies ItemDetails;
  });

  app.get<{ Params: { itemId: number; slot: string } }>(
    '/art/:itemId/:slot',
    { schema: { params: { type: 'object', properties: { itemId: { type: 'integer', minimum: 1 } } } } },
    async (req, reply) => {
      const missing = () =>
        reply
          .code(404)
          .header('cache-control', `public, max-age=${MISSING_MAX_AGE_SECONDS}`)
          .send({ code: 'NOT_FOUND', message: 'No artwork' } satisfies ApiError);
      const { itemId, slot } = req.params;
      if (!ART_SLOT.test(slot)) return missing();
      const url = await providerArtUrl(deps, itemId, slot);
      if (!url) return missing();
      let image;
      try {
        image = await deps.art.get(url);
      } catch (err) {
        if (!(err instanceof LogoBusyError)) throw err;
        return reply
          .code(503)
          .header('retry-after', '5')
          .send({ code: 'BUSY', message: 'Too many image fetches in progress' } satisfies ApiError);
      }
      if (!image) return missing();
      return reply
        .header('cache-control', `public, max-age=${LOGO_MAX_AGE_SECONDS}`)
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('x-content-type-options', 'nosniff')
        .type(image.contentType)
        .send(fs.createReadStream(image.path));
    },
  );

  app.get<{ Params: { id: number }; Querystring: { category?: string } }>(
    '/items/:id/context',
    { schema: { params: idParams, querystring: { type: 'object', properties: { category: { type: 'string', maxLength: 20 } } } } },
    async (req, reply): Promise<WatchContext> => {
      const item = deps.catalogue.getItem(req.params.id);
      if (!item || item.kind !== 'live') return reply.code(404).send(notFound('Live channel'));
      if (req.query.category === 'favourites') return { categoryId: null, label: 'Favourites' };
      const { visibleIds, displayName } = deps.curation.resolution(item.providerId, 'live', currentUserId(req));
      // The item's live categories, in the order the Live tab lists them.
      const mine = deps.db
        .prepare(
          `SELECT c.id AS id, c.name AS name FROM item_categories ic JOIN categories c ON c.id = ic.category_id
            WHERE ic.item_id = ? AND c.kind = 'live' AND c.provider_id = ? ORDER BY c.position, c.id`,
        )
        .all(item.id, item.providerId) as { id: number; name: string }[];
      const visible = mine.filter((c) => visibleIds.has(c.id));
      const asked = /^\d+$/.test(req.query.category ?? '') ? Number(req.query.category) : null;
      const chosen = visible.find((c) => c.id === asked) ?? visible[0];
      return chosen ? { categoryId: chosen.id, label: displayName(chosen.name) } : { categoryId: null, label: null };
    },
  );
};
