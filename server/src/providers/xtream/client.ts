import { Readable, pipeline } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import streamJson from 'stream-json';
import streamArrayMod from 'stream-json/streamers/StreamArray.js';
import type { Kind } from '@tv/shared';
import { ProviderError } from '../errors.ts';
import { formatCatchupStart, resolveProviderTimezone } from '../../guide/clock.ts';
import { decodeListing, normaliseItem, normaliseServerUrl } from './normalise.ts';
import type { Listing, RawItem } from './normalise.ts';

export type { RawItem } from './normalise.ts';

export type XtreamCreds = { serverUrl: string; username: string; password: string };
export type XtreamAccount = {
  status: string;
  maxConnections: number | null;
  expiresAt: number | null;
  allowedOutputFormats: string[];
  /** The provider's timezone (an IANA name, or 'UTC±HH:MM'); null when it cannot be told. */
  timezone: string | null;
};
export type RawCategory = { remoteId: string; name: string };
type Episode = { remoteId: string; title: string; episodeNum: number; containerExt: string; durationSec: number | null };
export type SeriesInfo = { seasons: { season: number; episodes: Episode[] }[] };

export interface XtreamClient {
  authenticate(): Promise<XtreamAccount>;
  getCategories(kind: Kind): Promise<RawCategory[]>;
  streamItems(kind: Kind): AsyncIterable<RawItem>;
  getSeriesInfo(seriesRemoteId: string): Promise<SeriesInfo>;
  liveUrl(remoteId: string, format: 'm3u8' | 'ts'): string;
  movieUrl(remoteId: string, ext: string): string;
  episodeUrl(episodeRemoteId: string, ext: string): string;
  /** The provider's XMLTV guide as a byte stream, destroyed with PROVIDER_UNREACHABLE after idleTimeoutMs without data. */
  xmltv(opts?: { signal?: AbortSignal; idleTimeoutMs?: number }): Promise<Readable>;
  /** One channel's listings, soonest first. tz (the provider's) reads wall-clock times when a listing has no epoch stamp. */
  epgTable(streamId: string, opts?: { signal?: AbortSignal; tz?: string | null }): Promise<Listing[]>;
  /** An Xtream timeshift (catch-up) URL in IPTVnator's REST form; tz is the provider's timezone. */
  timeshiftUrl(streamId: string, startSec: number, stopSec: number, tz: string | null, ext: 'ts' | 'm3u8'): string;
}

const ITEM_ACTION: Record<Kind, string> = { live: 'get_live_streams', movie: 'get_vod_streams', series: 'get_series' };
const CATEGORY_ACTION: Record<Kind, string> = {
  live: 'get_live_categories',
  movie: 'get_vod_categories',
  series: 'get_series_categories',
};

// stream-json is CommonJS; Node's ESM loader exposes module.exports as the default export.
const makeParser = (streamJson as unknown as { parser: () => Duplex }).parser;
const makeStreamArray = (streamArrayMod as unknown as { streamArray: () => Duplex }).streamArray;

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createXtreamClient(
  creds: XtreamCreds,
  opts: { userAgent: string; timeoutMs?: number; fetchFn?: typeof fetch },
): XtreamClient {
  const base = normaliseServerUrl(creds.serverUrl);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const u = encodeURIComponent(creds.username);
  const p = encodeURIComponent(creds.password);

  async function get(path: string, qs: URLSearchParams, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(`${base}/${path}?${qs}`, {
        headers: { 'user-agent': opts.userAgent },
        signal,
      });
    } catch {
      // Deliberately drop the underlying error: its text can embed the credential-bearing URL.
      throw new ProviderError('PROVIDER_UNREACHABLE', 'Could not reach the provider');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('PROVIDER_AUTH_FAILED', 'The provider rejected the credentials');
      }
      throw new ProviderError('PROVIDER_BAD_RESPONSE', `The provider returned HTTP ${res.status}`);
    }
    return res;
  }

  function request(
    action: string | null,
    extra: Record<string, string> = {},
    signal: AbortSignal = AbortSignal.timeout(timeoutMs),
  ): Promise<Response> {
    const qs = new URLSearchParams({ username: creds.username, password: creds.password });
    if (action) qs.set('action', action);
    for (const [k, v] of Object.entries(extra)) qs.set(k, v);
    return get('player_api.php', qs, signal);
  }

  async function json(action: string | null, extra?: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const res = await request(action, extra, signal);
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ProviderError('PROVIDER_UNREACHABLE', 'The connection to the provider was lost');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return JSON');
    }
  }

  return {
    async authenticate() {
      const body = await json(null);
      const info = isRecord(body) ? body.user_info : undefined;
      const server = isRecord(body) ? body.server_info : undefined;
      if (!isRecord(info)) {
        throw new ProviderError('PROVIDER_BAD_RESPONSE', 'The provider response had no account information');
      }
      if (Number(info.auth) === 0) throw new ProviderError('PROVIDER_AUTH_FAILED', 'The provider rejected the credentials');
      return {
        status: typeof info.status === 'string' ? info.status : 'Unknown',
        maxConnections: toNumber(info.max_connections),
        expiresAt: toNumber(info.exp_date),
        allowedOutputFormats: Array.isArray(info.allowed_output_formats) ? info.allowed_output_formats.map(String) : [],
        timezone: resolveProviderTimezone(isRecord(server) ? server : {}),
      };
    },

    async getCategories(kind) {
      const body = await json(CATEGORY_ACTION[kind]);
      if (!Array.isArray(body)) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Expected a list of categories');
      const out: RawCategory[] = [];
      for (const c of body) {
        if (!isRecord(c) || c.category_id == null || c.category_name == null) continue;
        out.push({ remoteId: String(c.category_id), name: String(c.category_name) });
      }
      return out;
    },

    async *streamItems(kind) {
      // timeoutMs bounds time-to-headers and body idle time; there is no total body deadline.
      const ac = new AbortController();
      let timer = setTimeout(() => ac.abort(), timeoutMs);
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(), timeoutMs);
      };
      let source: Readable | undefined;
      try {
        const res = await request(ITEM_ACTION[kind], {}, ac.signal);
        if (!res.body) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'The provider returned an empty response');
        touch();
        source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
        source.on('data', touch);
        const items = makeStreamArray();
        // pipeline forwards an error from any stage to `items`, so the loop below sees it.
        pipeline(source, makeParser(), items, () => {});
        for await (const chunk of items as AsyncIterable<{ value: unknown }>) {
          if (!isRecord(chunk.value)) continue;
          const item = normaliseItem(kind, chunk.value);
          if (item) yield item;
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (ac.signal.aborted) throw new ProviderError('PROVIDER_UNREACHABLE', 'The provider connection timed out');
        throw new ProviderError('PROVIDER_BAD_RESPONSE', 'The provider returned an unreadable item list');
      } finally {
        clearTimeout(timer);
        source?.destroy();
      }
    },

    async getSeriesInfo(seriesRemoteId) {
      const body = await json('get_series_info', { series_id: seriesRemoteId });
      if (!isRecord(body)) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Unexpected series info response');
      const eps = body.episodes;
      // Providers send either { "1": [...] } or [[...], [...]].
      const groups: [number | null, unknown[]][] = [];
      if (Array.isArray(eps)) {
        for (const g of eps) if (Array.isArray(g)) groups.push([null, g]);
      } else if (isRecord(eps)) {
        for (const [k, g] of Object.entries(eps)) if (Array.isArray(g)) groups.push([toNumber(k), g]);
      }
      const bySeason = new Map<number, Episode[]>();
      for (const [key, list] of groups) {
        for (const e of list) {
          if (!isRecord(e) || e.id == null) continue;
          const season = toNumber(e.season) ?? key ?? 1;
          const arr = bySeason.get(season) ?? [];
          const episodeNum = toNumber(e.episode_num) ?? arr.length + 1;
          const info = isRecord(e.info) ? e.info : {};
          arr.push({
            remoteId: String(e.id),
            title: typeof e.title === 'string' ? e.title : `Episode ${episodeNum}`,
            episodeNum,
            containerExt: typeof e.container_extension === 'string' && e.container_extension ? e.container_extension : 'mp4',
            durationSec: toNumber(info.duration_secs),
          });
          bySeason.set(season, arr);
        }
      }
      return {
        seasons: [...bySeason.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([season, episodes]) => ({ season, episodes: episodes.sort((a, b) => a.episodeNum - b.episodeNum) })),
      };
    },

    async xmltv(o = {}) {
      const idleMs = o.idleTimeoutMs ?? 120_000;
      const ac = new AbortController();
      const onCallerAbort = () => ac.abort();
      o.signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (o.signal?.aborted) ac.abort();
      let idle = false;
      let timer = setTimeout(() => ac.abort(), timeoutMs); // time to headers
      let source: Readable | undefined;
      // One cleanup, run when the returned stream closes (or on a failed start), so nothing outlives it.
      const cleanup = () => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onCallerAbort);
        ac.abort();
        source?.destroy();
      };
      const aborted = () => new DOMException('The guide request was aborted', 'AbortError');
      let res: Response;
      try {
        res = await get('xmltv.php', new URLSearchParams({ username: creds.username, password: creds.password }), ac.signal);
      } catch (e) {
        cleanup();
        throw o.signal?.aborted ? aborted() : e;
      }
      if (!res.body) {
        cleanup();
        throw new ProviderError('PROVIDER_BAD_RESPONSE', 'The provider returned an empty response');
      }
      clearTimeout(timer); // headers are in; the idle timer arms on the first read
      const src = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      source = src;
      // The idle timer only runs while we are waiting on the provider, never while the consumer applies backpressure.
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          idle = true;
          ac.abort();
        }, idleMs);
      };
      const out = new Readable({
        read() {
          arm();
          src.resume();
        },
        destroy(err, cb) {
          cleanup();
          cb(err);
        },
      });
      src.on('data', (chunk: Buffer) => {
        clearTimeout(timer);
        if (out.push(chunk)) arm();
        else src.pause();
      });
      src.on('end', () => {
        clearTimeout(timer);
        out.push(null);
      });
      src.on('error', () => {
        // Drop the underlying error: its text can embed the credential-bearing URL.
        if (idle) out.destroy(new ProviderError('PROVIDER_UNREACHABLE', 'The provider connection timed out'));
        else if (o.signal?.aborted) out.destroy(aborted());
        else out.destroy(new ProviderError('PROVIDER_UNREACHABLE', 'The connection to the provider was lost'));
      });
      src.pause();
      return out;
    },

    async epgTable(streamId, o: { signal?: AbortSignal; tz?: string | null } = {}) {
      const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(timeoutMs)]) : undefined;
      const attempt = async (action: string): Promise<unknown[] | null> => {
        const body = await json(action, { stream_id: streamId }, signal);
        const raw = isRecord(body) ? body.epg_listings : undefined;
        if (Array.isArray(raw)) return raw;
        // PHP sparse arrays arrive as an object of listings, or of arrays of listings.
        if (isRecord(raw)) return Object.values(raw).flatMap((v) => (Array.isArray(v) ? v : [v]));
        return null;
      };
      let raw: unknown[] | null = null;
      try {
        raw = await attempt('get_simple_data_table');
      } catch (e) {
        if (o.signal?.aborted || (e instanceof ProviderError && e.code === 'PROVIDER_AUTH_FAILED')) throw e;
      }
      // The provider's own typo for the same action.
      raw ??= await attempt('get_simple_date_table');
      // Valid JSON from both actions but no listings in either: the provider has none.
      return (raw ?? [])
        .map((l) => decodeListing(l, o.tz ?? null))
        .filter((l): l is Listing => l !== null)
        .sort((a, b) => a.start - b.start);
    },

    timeshiftUrl(streamId, startSec, stopSec, tz, ext) {
      const minutes = Math.max(1, Math.round((stopSec - startSec) / 60));
      return `${base}/timeshift/${u}/${p}/${minutes}/${formatCatchupStart(startSec, tz)}/${streamId}.${ext}`;
    },

    liveUrl: (id, format) => `${base}/live/${u}/${p}/${id}.${format}`,
    movieUrl: (id, ext) => `${base}/movie/${u}/${p}/${id}.${ext}`,
    episodeUrl: (id, ext) => `${base}/series/${u}/${p}/${id}.${ext}`,
  };
}
