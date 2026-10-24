import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';
import { fetchWithLimitRetry, MIRRORED_HEADERS } from './upstream.ts';

/**
 * FFmpeg's HTTP seek opens the new range request before it closes the old one (keeping it as a fallback),
 * and an MKV seek jumps to the cue index at the end of the file. A one-connection provider refuses the
 * second request, and the seek silently fails. FFmpeg reads VOD through this relay instead, which never
 * holds more than one provider connection per registration: each request takes the connection over.
 */
export type UpstreamRelay = {
  /** A loopback URL FFmpeg reads instead of source.url. All requests to it reach the provider over at most one connection. */
  register(source: { url: string; userAgent: string }): { url: string; unregister(): Promise<void> };
  close(): Promise<void>;
};

/** One provider request. `closed` resolves once it, and every request before it, is closed. */
type ProviderRequest = { abort: AbortController; closed: Promise<void> };

type Registration = {
  source: { url: string; userAgent: string };
  /** The newest request; each one aborts the one before it. */
  current: ProviderRequest | null;
};

const PASSED_STATUSES = new Set([200, 206, 416]);

export async function startUpstreamRelay(deps: { log: Log; retryDelaysMs?: readonly number[] }): Promise<UpstreamRelay> {
  const { log } = deps;
  const registrations = new Map<string, Registration>(); // by path
  const server = createServer((req, res) => {
    relay(req, res).catch((err: unknown) => {
      log.warn({ err: redactUrl(String(err)) }, 'relay: request failed');
      res.destroy();
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function relay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reg = registrations.get(req.url ?? '');
    if (!reg) return void res.writeHead(404).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, { allow: 'GET, HEAD' }).end();

    // Claimed before any await, so requests take turns in the order they arrive.
    const abort = new AbortController();
    let markClosed!: () => void;
    const closed = new Promise<void>((ok) => {
      markClosed = ok;
    });
    const previous = reg.current;
    const mine: ProviderRequest = { abort, closed };
    reg.current = mine;
    res.once('close', () => abort.abort()); // FFmpeg hung up, or has what it asked for
    previous?.abort.abort();
    try {
      await previous?.closed;
      await forward(reg.source, req, res, abort.signal);
    } finally {
      abort.abort(); // a no-op once the provider request is over; if forward() threw, it drops it
      if (reg.current === mine) reg.current = null;
      markClosed();
    }
  }

  /** Makes one provider request and relays its answer; returns once that request is closed. */
  async function forward(
    source: Registration['source'],
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = { 'user-agent': source.userAgent, 'accept-encoding': 'identity' };
    if (req.headers.range) headers.range = req.headers.range;
    let upstream: Response;
    try {
      signal.throwIfAborted(); // taken over, or FFmpeg left, while waiting for its turn
      upstream = await fetchWithLimitRetry(source.url, { method: req.method, headers, signal }, deps.retryDelaysMs);
    } catch (err) {
      if (signal.aborted) return void res.destroy();
      log.warn({ url: redactUrl(source.url), err: redactUrl(String(err)) }, 'relay: provider unreachable');
      return void res.writeHead(502).end();
    }

    if (signal.aborted || !PASSED_STATUSES.has(upstream.status)) {
      await upstream.body?.cancel().catch(() => {});
      if (signal.aborted) return void res.destroy();
      log.warn({ url: redactUrl(source.url), status: upstream.status }, 'relay: provider refused');
      return void res.writeHead(upstream.status).end();
    }
    const out: Record<string, string> = {};
    for (const name of MIRRORED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out[name] = value;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) return void res.end();
    const body = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
    const bodyClosed = new Promise((ok) => body.once('close', ok)); // ended, failed or cut short
    // Cut short when the next request takes over, FFmpeg hangs up or the provider fails; FFmpeg sees a short read.
    await pipeline(body, res).catch(() => {});
    await bodyClosed;
  }

  /** Aborts the registration's newest request and waits until it, and so every one before it, is closed. */
  async function release(reg: Registration): Promise<void> {
    const last = reg.current;
    last?.abort.abort();
    await last?.closed;
  }

  return {
    register(source) {
      // The basename keeps FFmpeg's extension hint; an Xtream URL's basename never holds the credentials.
      const path = `/${randomUUID()}/${posix.basename(new URL(source.url).pathname)}`;
      const reg: Registration = { source, current: null };
      registrations.set(path, reg);
      return {
        url: origin + path,
        async unregister() {
          registrations.delete(path);
          await release(reg);
        },
      };
    },

    async close() {
      const all = [...registrations.values()];
      registrations.clear();
      await Promise.all(all.map(release));
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
    },
  };
}
