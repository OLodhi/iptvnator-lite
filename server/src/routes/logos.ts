import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiError } from '@tv/shared';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import { LogoBusyError, type LogoCache } from '../logos/cache.ts';

export const LOGO_MAX_AGE_SECONDS = 604800;
/** As long as the logo cache remembers a failed fetch. */
const MISSING_MAX_AGE_SECONDS = 3600;

export const logoRoutes = (deps: { catalogue: CatalogueRepo; logos: LogoCache }): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Params: { itemId: number } }>(
      '/logos/:itemId',
      { schema: { params: { type: 'object', properties: { itemId: { type: 'integer', minimum: 1 } } } } },
      async (req, reply) => {
        const notFound = () =>
          reply
            .code(404)
            .header('cache-control', `public, max-age=${MISSING_MAX_AGE_SECONDS}`)
            .send({ code: 'NOT_FOUND', message: 'No logo for this item' } satisfies ApiError);
        const url = deps.catalogue.getItem(req.params.itemId)?.logoUrl;
        if (!url) return notFound();
        let image;
        try {
          image = await deps.logos.get(url);
        } catch (err) {
          if (!(err instanceof LogoBusyError)) throw err;
          return reply
            .code(503)
            .header('retry-after', '5')
            .send({ code: 'BUSY', message: 'Too many logo fetches in progress' } satisfies ApiError);
        }
        if (!image) return notFound();
        return reply
          .header('cache-control', `public, max-age=${LOGO_MAX_AGE_SECONDS}`)
          // Provider-supplied SVG must never run script from our origin.
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
          .header('x-content-type-options', 'nosniff')
          .type(image.contentType)
          .send(fs.createReadStream(image.path));
      },
    );
  };
