import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiError, GridRow, GuideChip, GuideMeta, GuidePrefs, GuideSource, GuideView, Page, Programme, WhatsOnEntry,
} from '@tv/shared';
import type { Presenter } from '../browse/presenter.ts';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { CurationService } from '../curation/service.ts';
import type { Db } from '../db/db.ts';
import { relinkGuide } from '../guide/match.ts';
import type { GuideQueries } from '../guide/query.ts';
import type { GuideRunner } from '../guide/runner.ts';
import { visibleLiveItemIds } from '../guide/visible.ts';
import type { PersonalService } from '../personal/service.ts';
import type { PrefsService } from '../prefs/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { currentUserId } from '../users.ts';

const DAY = 86_400;
const WHATS_ON_LIMIT = { default: 50, max: 200 };
const GRID_LIMIT = { default: 30, max: 100 };
const MAX_PROGRAMME_ITEMS = 200;
const SOURCES_LIMIT = { default: 20, max: 50 };
const PREFS_KEY = 'guide';
const FILTER_PATTERN = '^(all|favourites|category:[0-9]+)$';

type Window = { from?: number; to?: number };
const filterSchema = { type: 'string', pattern: FILTER_PATTERN };
/** Over-large limits are clamped to the endpoint's maximum, as in search; zero and below are rejected. */
const limitSchema = { type: 'integer', minimum: 1 };

export const guideRoutes = (deps: {
  db: Db;
  guide: GuideRunner;
  providers: ProviderService;
  prefs: PrefsService;
  curation: CurationService;
  personal: PersonalService;
  catalogue: CatalogueRepo;
  presenter: Presenter;
  queries: GuideQueries;
  /** Milliseconds. */
  now: () => number;
}): FastifyPluginAsync =>
  async (app) => {
    const { db, guide, queries } = deps;
    const idSchema = { params: { type: 'object', properties: { id: { type: 'integer' } } } };
    const notFound = (what: string, id: number): ApiError => ({ code: 'NOT_FOUND', message: `${what} ${id} not found` });
    const invalid = (reply: FastifyReply, message: string) =>
      reply.code(400).send({ code: 'VALIDATION', message } satisfies ApiError);

    app.setErrorHandler((err: Error, _req, reply) => {
      if ((err as { validation?: unknown }).validation) return invalid(reply, err.message);
      throw err;
    });

    // Until there are several providers to choose between, the guide is of the first one.
    const firstProvider = () => deps.providers.list()[0];
    const nowSec = () => Math.floor(deps.now() / 1000);

    /** The chips for a user: All, Favourites, then each pinned live category in pin order. */
    function chipsFor(userId: number, providerId: number): GuideChip[] {
      const names = new Map(deps.catalogue.listCategories(providerId, 'live').map((c) => [c.id, c.name]));
      const { displayName } = deps.curation.resolution(providerId, 'live', userId);
      const pinned: GuideChip[] = [];
      for (const id of deps.personal.pinnedCategoryIds(userId, providerId, 'live')) {
        const name = names.get(id);
        if (name !== undefined) pinned.push({ filter: `category:${id}`, label: displayName(name) });
      }
      return [{ filter: 'all', label: 'All channels' }, { filter: 'favourites', label: 'Favourites' }, ...pinned];
    }

    function prefsFor(userId: number, providerId: number, chips: GuideChip[]): GuidePrefs {
      const fallback: GuidePrefs = {
        view: 'grid',
        filter: deps.personal.favouriteItemIds(userId, providerId, 'live').length > 0 ? 'favourites' : 'all',
      };
      const stored = deps.prefs.get<Partial<GuidePrefs> | null>(userId, PREFS_KEY, null);
      const view: GuideView = stored?.view === 'grid' || stored?.view === 'whatson' ? stored.view : fallback.view;
      const filter = chips.some((c) => c.filter === stored?.filter) ? (stored!.filter as string) : fallback.filter;
      return { view, filter };
    }

    /** Item ids for a filter, in display order. A category that is neither pinned nor visible gives none. */
    function orderFor(req: FastifyRequest, providerId: number, filter: string): number[] {
      const userId = currentUserId(req);
      if (filter === 'favourites') return deps.personal.favouriteItemIds(userId, providerId, 'live');
      if (filter.startsWith('category:')) {
        const id = Number(filter.slice('category:'.length));
        const allowed =
          deps.personal.pinnedCategoryIds(userId, providerId, 'live').includes(id) ||
          deps.curation.resolution(providerId, 'live', userId).visibleIds.has(id);
        if (!allowed) return [];
        return db
          .prepare(
            `SELECT ic.item_id FROM item_categories ic JOIN categories c ON c.id = ic.category_id
              WHERE ic.category_id = ? AND c.provider_id = ? AND c.kind = 'live' ORDER BY ic.position, ic.item_id`,
          )
          .pluck()
          .all(id, providerId) as number[];
      }
      return visibleLiveItemIds(db, deps.curation, providerId, userId);
    }

    /** Both ends are required; `maxSec` bounds the window. Returns the error text, or null when fine. */
    const windowError = (w: Window, maxSec: number): string | null => {
      if (w.from === undefined || w.to === undefined) return 'from and to are required';
      if (w.from >= w.to) return 'from must be before to';
      if (w.to - w.from > maxSec) return `The window is at most ${maxSec / 3600} hours`;
      return null;
    };

    const offsetOf = (cursor: string | undefined): number => {
      if (!cursor) return 0;
      const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    };
    const cursorFor = (offset: number): string => Buffer.from(String(offset)).toString('base64url');

    app.post<{ Params: { id: number } }>('/providers/:id/guide', { schema: idSchema }, async (req, reply) => {
      if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound('Provider', req.params.id));
      guide.start(req.params.id);
      return reply.code(202).send({ started: true });
    });

    app.get<{ Params: { id: number } }>('/providers/:id/guide', { schema: idSchema }, async (req, reply) => {
      if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound('Provider', req.params.id));
      return guide.status(req.params.id);
    });

    app.get('/guide', async (req): Promise<GuideMeta> => {
      const provider = firstProvider();
      if (!provider) {
        return { providerId: null, chips: [], prefs: { view: 'grid', filter: 'all' }, range: null, status: null };
      }
      const userId = currentUserId(req);
      const chips = chipsFor(userId, provider.id);
      return {
        providerId: provider.id,
        chips,
        prefs: prefsFor(userId, provider.id, chips),
        range: queries.range(provider.id),
        status: guide.status(provider.id),
      };
    });

    app.put<{ Body: GuidePrefs }>(
      '/me/prefs/guide',
      {
        schema: {
          body: {
            type: 'object',
            required: ['view', 'filter'],
            additionalProperties: false,
            properties: { view: { enum: ['whatson', 'grid'] }, filter: filterSchema },
          },
        },
      },
      async (req, reply) => {
        const { view, filter } = req.body;
        deps.prefs.set(currentUserId(req), PREFS_KEY, { view, filter });
        return reply.code(204).send();
      },
    );

    app.get<{ Querystring: Window & { filter?: string; mode?: 'now' | 'range' | 'past'; cursor?: string; limit?: number } }>(
      '/guide/whats-on',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              filter: filterSchema,
              mode: { enum: ['now', 'range', 'past'] },
              from: { type: 'integer', minimum: 0 },
              to: { type: 'integer', minimum: 0 },
              cursor: { type: 'string', maxLength: 512 },
              limit: limitSchema,
            },
          },
        },
      },
      async (req, reply): Promise<Page<WhatsOnEntry> | FastifyReply> => {
        const { mode = 'now', filter = 'all', cursor } = req.query;
        const limit = Math.min(req.query.limit ?? WHATS_ON_LIMIT.default, WHATS_ON_LIMIT.max);
        if (mode !== 'now') {
          const problem = windowError(req.query, 2 * DAY);
          if (problem) return invalid(reply, problem);
        }
        const provider = firstProvider();
        if (!provider) return { items: [], nextCursor: null };
        const now = nowSec();
        const page = queries.whatsOn({
          providerId: provider.id, order: orderFor(req, provider.id, filter), mode,
          fromSec: req.query.from, toSec: req.query.to, nowSec: now, cursor: cursor ?? null, limit,
        });
        const presented = new Map(
          deps.presenter
            .items(page.items.flatMap((e) => deps.catalogue.getItem(e.itemId) ?? []), currentUserId(req))
            .map((i) => [i.id, i]),
        );
        const items: WhatsOnEntry[] = [];
        for (const { itemId, programme } of page.items) {
          const item = presented.get(itemId);
          if (!item) continue;
          const days = item.catchupDays ?? 0;
          items.push({
            item,
            programme,
            live: programme.startSec <= now && now < programme.stopSec,
            catchup: days > 0 && programme.startSec >= now - days * DAY && programme.startSec <= now,
          });
        }
        return { items, nextCursor: page.nextCursor };
      },
    );

    app.get<{ Querystring: Window & { filter?: string; cursor?: string; limit?: number } }>(
      '/guide/grid',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              filter: filterSchema,
              from: { type: 'integer', minimum: 0 },
              to: { type: 'integer', minimum: 0 },
              cursor: { type: 'string', maxLength: 512 },
              limit: limitSchema,
            },
          },
        },
      },
      async (req, reply): Promise<Page<GridRow> | FastifyReply> => {
        const problem = windowError(req.query, DAY);
        if (problem) return invalid(reply, problem);
        const { filter = 'all', cursor } = req.query;
        const limit = Math.min(req.query.limit ?? GRID_LIMIT.default, GRID_LIMIT.max);
        const provider = firstProvider();
        if (!provider) return { items: [], nextCursor: null };
        const order = orderFor(req, provider.id, filter);
        const offset = offsetOf(cursor);
        const ids = order.slice(offset, offset + limit);
        const items = deps.presenter.items(ids.flatMap((id) => deps.catalogue.getItem(id) ?? []), currentUserId(req));
        const present = new Map(items.map((i) => [i.id, i]));
        const programmes = queries.programmesFor(provider.id, ids, req.query.from!, req.query.to!);
        const linked = queries.linkedItemIds(provider.id, ids);
        const rows: GridRow[] = ids.flatMap((id) => {
          const item = present.get(id);
          return item ? [{ item, programmes: programmes.get(id) ?? [], hasGuide: linked.has(id) }] : [];
        });
        return { items: rows, nextCursor: offset + limit < order.length ? cursorFor(offset + limit) : null };
      },
    );

    app.get<{ Querystring: Window & { items: string } }>(
      '/guide/programmes',
      {
        schema: {
          querystring: {
            type: 'object',
            required: ['items'],
            properties: {
              items: { type: 'string', pattern: '^[0-9]+(,[0-9]+)*$' },
              from: { type: 'integer', minimum: 0 },
              to: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      async (req, reply): Promise<Record<string, Programme[]> | FastifyReply> => {
        const ids = [...new Set(req.query.items.split(',').map(Number))];
        if (ids.length > MAX_PROGRAMME_ITEMS) return invalid(reply, `At most ${MAX_PROGRAMME_ITEMS} items`);
        const problem = windowError(req.query, DAY);
        if (problem) return invalid(reply, problem);
        const provider = firstProvider();
        const found = provider ? queries.programmesFor(provider.id, ids, req.query.from!, req.query.to!) : new Map();
        return Object.fromEntries(ids.map((id) => [String(id), found.get(id) ?? []]));
      },
    );

    app.get<{ Params: { id: number }; Querystring: { q?: string; limit?: number } }>(
      '/providers/:id/guide/sources',
      {
        schema: {
          ...idSchema,
          querystring: {
            type: 'object',
            properties: { q: { type: 'string', maxLength: 200 }, limit: limitSchema },
          },
        },
      },
      async (req, reply): Promise<GuideSource[] | FastifyReply> => {
        if (!deps.providers.get(req.params.id)) return reply.code(404).send(notFound('Provider', req.params.id));
        return queries.sources(req.params.id, req.query.q ?? '', Math.min(req.query.limit ?? SOURCES_LIMIT.default, SOURCES_LIMIT.max));
      },
    );

    const hasChannel = db
      .prepare(
        `SELECT 1 FROM guide_channels gc
           JOIN guide_state gs ON gs.provider_id = gc.provider_id AND gs.generation = gc.generation
          WHERE gc.provider_id = ? AND gc.key = ?`,
      )
      .pluck();
    const setMap = db.prepare(
      `INSERT INTO guide_maps (provider_id, item_remote_id, channel_key) VALUES (?, ?, ?)
       ON CONFLICT (provider_id, item_remote_id) DO UPDATE SET channel_key = excluded.channel_key`,
    );
    const clearMap = db.prepare('DELETE FROM guide_maps WHERE provider_id = ? AND item_remote_id = ?');

    app.put<{ Params: { id: number }; Body: { key: string | null } }>(
      '/items/:id/guide-source',
      {
        // Before validation, which would coerce a number to "5" and silently strip extra properties.
        preValidation: async (req, reply) => {
          const body = req.body;
          if (typeof body !== 'object' || body === null) return;
          const { key, ...extra } = body as { key?: unknown };
          if (Object.keys(extra).length > 0) return invalid(reply, 'Only key is accepted');
          if (key !== undefined && key !== null && typeof key !== 'string') return invalid(reply, 'key must be a string or null');
        },
        schema: {
          ...idSchema,
          body: {
            type: 'object',
            required: ['key'],
            additionalProperties: false,
            properties: { key: { type: ['string', 'null'], minLength: 1, maxLength: 512 } },
          },
        },
      },
      async (req, reply) => {
        const item = deps.catalogue.getItem(req.params.id);
        if (!item) return reply.code(404).send(notFound('Item', req.params.id));
        if (item.kind !== 'live') return invalid(reply, 'Only live channels have a guide source');
        const { key } = req.body;
        if (key !== null && hasChannel.get(item.providerId, key) === undefined) {
          return reply.code(404).send({ code: 'NOT_FOUND', message: `Guide channel ${key} not found` } satisfies ApiError);
        }
        db.transaction(() => {
          if (key === null) clearMap.run(item.providerId, item.remoteId);
          else setMap.run(item.providerId, item.remoteId, key);
          relinkGuide(db, item.providerId);
        })();
        // Programmes are stored only for wanted channels, so the new channel's arrive with a refresh.
        guide.start(item.providerId);
        return reply.code(204).send();
      },
    );
  };
