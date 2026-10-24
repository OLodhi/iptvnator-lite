import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, PlayRequest } from '@tv/shared';
import type { CatalogueRepo } from '../catalogue/repo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { CLIENT_ID, PlaybackError } from '../playback/sessions.ts';
import type { SessionManager } from '../playback/sessions.ts';
import { resolveSourceUrl, SourceError } from '../playback/sourceUrl.ts';
import { ProviderError } from '../providers/errors.ts';
import type { PersonalService } from '../personal/service.ts';
import { currentUserId } from '../users.ts';
import type { ProviderService } from '../providers/service.ts';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';

export type PlaybackRouteDeps = {
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
  providers: ProviderService;
  sessions: SessionManager;
  personal: PersonalService;
  log: Log;
  /** Sent to the provider for every stream. */
  userAgent: string;
  /** How often a streaming direct response re-checks that its session is still running. */
  touchIntervalMs?: number;
};

type SessionParams = { id: string; clientId: string };

/** A direct stream in flight: one viewer's request, and the provider request behind it. */
type DirectProxy = {
  sessionId: string;
  clientId: string;
  /** Ends it because its session is over (as opposed to the viewer leaving or the provider failing). */
  stop(): void;
  /** Resolves once the provider request has been aborted and its body closed. */
  settled: Promise<void>;
};

const TOUCH_INTERVAL_MS = 10_000;
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;
// Only what FFmpeg writes into a session dir: playlists, segments and the fMP4 init file.
// Plain names only, so nothing can climb out of the dir (the session manager checks again).
const SESSION_FILE = /^(?:[\w-]+\.(m3u8|ts|m4s)|init\.(mp4))$/;
const FILE_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
};
// Everything else the provider sends (cookies, server names, ...) stays on the server.
const MIRRORED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

const playSchema = {
  type: 'object',
  required: ['itemId', 'clientId'],
  properties: {
    itemId: { type: 'integer' },
    clientId: { type: 'string', pattern: CLIENT_ID.source },
    episodeRemoteId: { type: 'string', minLength: 1 },
    startAtSec: { type: 'number', minimum: 0 },
  },
};

export const playbackRoutes = (deps: PlaybackRouteDeps): FastifyPluginAsync =>
  async (app) => {
    const { sessions } = deps;
    const touchIntervalMs = deps.touchIntervalMs ?? TOUCH_INTERVAL_MS;
    const proxies = new Set<DirectProxy>();

    /** Ends the matching direct streams and waits until their provider requests are closed. */
    async function endProxies(match: (p: DirectProxy) => boolean): Promise<void> {
      const ending = [...proxies].filter(match);
      for (const p of ending) p.stop();
      await Promise.all(ending.map((p) => p.settled));
    }

    const notFound = (reply: FastifyReply) =>
      reply.code(404).send({ code: 'NOT_FOUND', message: 'Session or file not found' } satisfies ApiError);

    app.setErrorHandler((err: Error, _req, reply) => {
      if ((err as { validation?: unknown }).validation) {
        return reply.code(400).send({ code: 'VALIDATION', message: err.message } satisfies ApiError);
      }
      if (err instanceof SourceError) {
        return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ code: err.code, message: err.message } satisfies ApiError);
      }
      if (err instanceof PlaybackError) {
        const body: ApiError = { code: err.code, message: err.message };
        if (err.code === 'PROVIDER_CONNECTION_LIMIT') return reply.code(409).send({ ...body, details: err.details });
        return reply.code(502).send(body);
      }
      if (err instanceof ProviderError) {
        return reply.code(502).send({ code: err.code, message: err.message } satisfies ApiError);
      }
      throw err;
    });

    // Long direct streams would otherwise hold app.close() open until they finish.
    app.addHook('preClose', () => endProxies(() => true));

    app.post<{ Body: PlayRequest }>('/play', { schema: { body: playSchema } }, async (req) => {
      const source = await resolveSourceUrl(deps, req.body);
      // A direct stream this viewer still has open holds a provider connection that the session manager
      // already counts as free once it preempts that session. Close it first, or a one-connection
      // provider refuses the new stream.
      await endProxies((p) => p.clientId === req.body.clientId);
      const started = await sessions.start({
        ...source,
        userAgent: deps.userAgent,
        startAtSec: req.body.startAtSec ?? 0,
        clientId: req.body.clientId,
        quality: 'original',
      });
      // Only a stream that actually started counts as watched.
      deps.personal.recordPlay(currentUserId(req), req.body.itemId, req.body.episodeRemoteId ?? null);
      return started;
    });

    app.post<{ Params: SessionParams }>('/sessions/:id/:clientId/heartbeat', async (req, reply) => {
      if (!sessions.touch(req.params.id, req.params.clientId)) return notFound(reply);
      return reply.code(204).send();
    });

    app.delete<{ Params: SessionParams }>('/sessions/:id/:clientId', async (req, reply) => {
      const { id, clientId } = req.params;
      await endProxies((p) => p.sessionId === id && p.clientId === clientId);
      await sessions.release(id, clientId);
      return reply.code(204).send();
    });

    // Registered before the file route it would otherwise look like. HEAD is explicit: Fastify's automatic
    // HEAD route would read (and discard) the whole movie from the provider.
    app.route<{ Params: SessionParams }>({
      method: ['GET', 'HEAD'],
      url: '/sessions/:id/:clientId/direct',
      handler: async (req, reply) => {
        const { id, clientId } = req.params;
        if (!sessions.touch(id, clientId)) return notFound(reply);
        const source = sessions.directSource(id);
        if (!source) return notFound(reply);
        return proxyDirect(req, reply, { sessionId: id, clientId }, source);
      },
    });

    app.get<{ Params: SessionParams & { file: string } }>('/sessions/:id/:clientId/:file', async (req, reply) => {
      const { id, clientId, file } = req.params;
      const match = SESSION_FILE.exec(file);
      const ext = match?.[1] ?? match?.[2];
      if (!ext || !sessions.touch(id, clientId)) return notFound(reply);
      const path = sessions.resolveFile(id, file);
      if (!path) return notFound(reply);

      if (ext === 'm3u8') {
        // Small, and rewritten by FFmpeg every segment: read it whole rather than stream a moving file.
        let playlist: Buffer;
        try {
          playlist = await readFile(path);
        } catch {
          return notFound(reply);
        }
        return reply.type(FILE_TYPES[ext]!).header('cache-control', 'no-cache').send(playlist);
      }
      let handle: FileHandle;
      let size: number;
      try {
        handle = await open(path, 'r');
      } catch {
        return notFound(reply); // not written yet, or already deleted from the live window
      }
      try {
        size = (await handle.stat()).size;
      } catch {
        await handle.close();
        return notFound(reply);
      }
      return reply.type(FILE_TYPES[ext]!).header('content-length', size).send(handle.createReadStream());
    });

    /** Streams the provider's file to the viewer, passing Range through, for as long as the session lives. */
    async function proxyDirect(
      req: FastifyRequest,
      reply: FastifyReply,
      viewer: { sessionId: string; clientId: string },
      source: { url: string; userAgent: string },
    ): Promise<FastifyReply> {
      const head = req.method === 'HEAD';
      const upstream = new AbortController();
      let body: Readable | null = null;
      let stopped = false; // the session ended
      let viewerGone = false; // the viewer hung up before the response was complete
      let settle!: () => void;
      const proxy: DirectProxy = {
        ...viewer,
        settled: new Promise<void>((ok) => {
          settle = ok;
        }),
        stop() {
          stopped = true;
          // Mid-stream, cut the viewer's connection itself. (Merely destroying `body` can let the response
          // end as if complete, leaving the viewer waiting on a keep-alive socket for the missing bytes.)
          if (body) reply.raw.destroy();
          upstream.abort();
        },
      };
      proxies.add(proxy);
      // Re-checked while streaming: a session that was reaped stops being read from the provider.
      const recheck = setInterval(() => {
        if (!sessions.touch(viewer.sessionId, viewer.clientId)) proxy.stop();
      }, touchIntervalMs);
      recheck.unref();
      const done = () => {
        clearInterval(recheck);
        proxies.delete(proxy);
        settle();
      };
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) viewerGone = true;
        upstream.abort();
      });
      const discard = async (res: Response) => {
        upstream.abort();
        await res.body?.cancel().catch(() => {});
        done();
      };
      /** Answers a request whose provider request ended early, blaming the provider only if it was at fault. */
      const endEarly = (message: string, warn: () => void) => {
        if (viewerGone || reply.raw.destroyed) return reply.hijack(); // nobody to answer, nothing to report
        if (stopped) return notFound(reply);
        warn();
        return reply.code(502).send({ code: 'UPSTREAM_ERROR', message } satisfies ApiError);
      };

      const headers: Record<string, string> = { 'user-agent': source.userAgent, 'accept-encoding': 'identity' };
      if (req.headers.range) headers.range = req.headers.range;
      const headersTimer = setTimeout(() => upstream.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(source.url, { method: head ? 'HEAD' : 'GET', headers, signal: upstream.signal });
      } catch (err) {
        done();
        return endEarly('The provider did not answer', () =>
          deps.log.warn({ url: redactUrl(source.url), err: redactUrl(String(err)) }, 'direct stream: provider unreachable'),
        );
      } finally {
        clearTimeout(headersTimer);
      }

      if (stopped || viewerGone || (res.status !== 200 && res.status !== 206 && res.status !== 416)) {
        await discard(res);
        return endEarly(`The provider answered ${res.status}`, () =>
          deps.log.warn({ url: redactUrl(source.url), status: res.status }, 'direct stream: provider refused'),
        );
      }
      reply.code(res.status);
      for (const name of MIRRORED_HEADERS) {
        const value = res.headers.get(name);
        if (value !== null) reply.header(name, value);
      }
      if (head || res.status === 416 || !res.body) {
        await discard(res);
        return reply.send();
      }
      body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      body.once('close', done); // ended, failed, cut short or stopped: the provider request is over
      return reply.send(body);
    }
  };
