import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { generateCatalogue, smallCatalogue } from './catalogue.ts';
import type { FakeCatalogue, FakeKind } from './catalogue.ts';
import { DEFAULT_WINDOW, formatInZone, listings, xmltvChunks } from './guide.ts';
import type { GuideWindow } from './guide.ts';

export type GuideMode = 'xmltv' | 'gzip' | 'none' | 'error' | 'truncated' | 'stall';

export type FakeXtreamOptions = {
  port?: number;
  username?: string;
  password?: string;
  catalogue?: FakeCatalogue;
  mediaDir: string;
  maxConnections?: number;
  /** Serve live like a real provider: TS streamed at its real bitrate and looped forever, HLS as a sliding window. */
  paced?: boolean;
  /** Paced only: how long the live TS files play for, which sets their bitrate (size / seconds). Default 30 (make-media). */
  pacedMediaSeconds?: number;
  /** How /xmltv.php answers. Default 'xmltv'. */
  guide?: GuideMode;
  /** false makes both listing table actions return []. Default true. */
  listings?: boolean;
  /** 'typo' makes get_simple_data_table answer an error object, and only get_simple_date_table return listings. Default 'simple'. */
  tableAction?: 'simple' | 'typo';
  /** The provider's timezone, for server_info and listing times. Default Europe/London. */
  timezone?: string;
  /** Clock for the guide and server_info, in ms. Default Date.now. */
  now?: () => number;
  /** The span of generated programmes. Default 3 days back, 2 ahead, 60 minutes each. */
  guideWindow?: GuideWindow;
};

export type TimeshiftRequest = { id: string; start: string; durationMin: number; ext: string };

export type FakeXtream = {
  url: string;
  close(): Promise<void>;
  openMediaConnections(): number;
  /** Media requests refused because the connection limit was reached (oldest first), with the paths holding it. */
  refusedMediaRequests(): RefusedRequest[];
  setCatalogue(c: FakeCatalogue): void;
  timeshiftRequests(): TimeshiftRequest[];
};

export type RefusedRequest = { path: string; heldBy: string[] };

// Media is mapped by stream id; the requested extension is ignored (ruling R1).
const MEDIA: Record<'live' | 'movie' | 'series', Record<string, string>> = {
  live: { '1': 'hls/index.m3u8', '2': 'raw.ts', '3': 'mpeg2.ts' },
  // Movie 4 is in no built-in catalogue: tests that need its moov-at-end MP4 add it.
  movie: { '1': 'movie.mkv', '2': 'movie.mp4', '3': 'hevc.mkv', '4': 'movie-moov-end.mp4' },
  series: { '101': 'movie.mkv', '102': 'movie.mkv', '201': 'movie.mkv' },
};

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
};

const CHUNK = 1000;

// Paced live: the generated live media are 30 s long (make-media), so bitrate = size / 30 s.
const MEDIA_SECONDS = 30;
const PACE_MS = 100;
const HLS_SEGMENT_MS = 2000;
const HLS_SEGMENTS = 15; // real segment files in media/hls
const HLS_WINDOW = 6;

export async function startFakeXtream(opts: FakeXtreamOptions): Promise<FakeXtream> {
  const username = opts.username ?? 'u';
  const password = opts.password ?? 'p';
  const maxConnections = opts.maxConnections ?? 1;
  const mediaSeconds = opts.pacedMediaSeconds ?? MEDIA_SECONDS;
  const mediaDir = resolve(opts.mediaDir);
  let catalogue = opts.catalogue ?? smallCatalogue();
  const open = new Map<ServerResponse, string>(); // open media responses → request path
  const refused: RefusedRequest[] = [];
  const startedAt = Date.now();
  const guideMode = opts.guide ?? 'xmltv';
  const timezone = opts.timezone ?? 'Europe/London';
  const window = opts.guideWindow ?? DEFAULT_WINDOW;
  const now = opts.now ?? (() => Date.now());
  const timeshifts: TimeshiftRequest[] = [];
  let baseUrl = '';

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    if (path === '/player_api.php') return api(url, res);
    if (path === '/xmltv.php') return xmltv(url, res);
    const shift = /^\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/(\d{4}-\d{2}-\d{2}:\d{2}-\d{2})\/(\d+)\.(\w+)$/.exec(path);
    if (shift) {
      const [, user, pass, minutes, start, id, ext] = shift as unknown as string[];
      if (decodeURIComponent(user!) !== username || decodeURIComponent(pass!) !== password) return status(res, 403);
      if (!catalogue.live.items.some((i) => String(i.id) === id)) return status(res, 404);
      timeshifts.push({ id: id!, start: start!, durationMin: Number(minutes), ext: ext! });
      return serveMedia(req, res, join(mediaDir, 'raw.ts'), 'file');
    }
    const media = /^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/.exec(path);
    if (media) {
      const [, kind, user, pass, id] = media as unknown as [string, 'live' | 'movie' | 'series', string, string, string];
      if (decodeURIComponent(user) !== username || decodeURIComponent(pass) !== password) return status(res, 403);
      const file = MEDIA[kind][id];
      if (!file) return status(res, 404);
      const as = file.endsWith('.m3u8') ? 'playlist' : kind === 'live' ? 'live' : 'file';
      return serveMedia(req, res, join(mediaDir, ...file.split('/')), as);
    }
    const seg = /^\/hls\/([^/]+)$/.exec(path);
    const liveSeg = opts.paced ? /^seg-live-(\d+)\.ts$/.exec(seg?.[1] ?? '') : null;
    if (liveSeg) {
      const name = `seg${String(Number(liveSeg[1]) % HLS_SEGMENTS).padStart(3, '0')}.ts`;
      return serveMedia(req, res, join(mediaDir, 'hls', name), 'file');
    }
    if (seg) return serveMedia(req, res, join(mediaDir, 'hls', basename(seg[1]!)), 'file');
    return status(res, 404);
  }

  function status(res: ServerResponse, code: number): void {
    res.writeHead(code).end();
  }

  /** Counts a connection as open from now until the response closes. Returns false when over the limit. */
  function acquire(req: IncomingMessage, res: ServerResponse): boolean {
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    if (open.size >= maxConnections) {
      refused.push({ path, heldBy: [...open.values()] });
      return false;
    }
    open.set(res, path);
    res.once('close', () => {
      open.delete(res);
    });
    return true;
  }

  /**
   * `live` is served like a provider's live TS stream: no length and no ranges, so it isn't seekable.
   * (A seekable input makes FFmpeg open a second connection for each seek, which a live stream never gets.)
   */
  async function serveMedia(
    req: IncomingMessage,
    res: ServerResponse,
    file: string,
    as: 'playlist' | 'live' | 'file',
  ): Promise<void> {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return status(res, 404);
    }
    if (!acquire(req, res)) return status(res, 403);
    const type = CONTENT_TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream';

    if (as === 'playlist') {
      const text = opts.paced ? pacedPlaylist() : (await readFile(file, 'utf8'))
        .split(/\r?\n/)
        .map((l) => (l && !l.startsWith('#') ? `/hls/${basename(l)}` : l))
        .join('\n');
      res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    if (as === 'live') {
      res.writeHead(200, { 'content-type': type });
      if (opts.paced) {
        await paceLive(res, file, size);
        return;
      }
      const stream = createReadStream(file);
      pipeline(stream, res, () => stream.destroy());
      return;
    }

    let start = 0;
    let end = size - 1;
    let code = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      code = 206;
    }
    const headers: Record<string, string | number> = {
      'content-type': type,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
    };
    if (code === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(code, headers);
    const stream = createReadStream(file, { start, end });
    pipeline(stream, res, () => stream.destroy());
  }

  /** Writes `bitrate / 10` bytes every 100 ms, restarting at the file's start at the end, until the client goes. */
  async function paceLive(res: ServerResponse, file: string, size: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    res.once('close', () => clearInterval(timer)); // before the read, so a client that leaves during it starts nothing
    const data = await readFile(file);
    if (res.destroyed) return;
    if (data.length === 0) {
      res.end();
      return;
    }
    const bytesPerMs = size / mediaSeconds / 1000;
    const maxBurst = Math.ceil(bytesPerMs * 1000); // about 1 s of data
    const t0 = Date.now();
    let sent = 0; // the target is elapsed x bitrate, so late or skipped ticks catch up
    let offset = 0;
    timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      if (res.writableNeedDrain) return; // the client is behind; don't pile up
      let left = Math.min(maxBurst, Math.floor((Date.now() - t0) * bytesPerMs) - sent);
      if (left <= 0) return;
      sent += left;
      while (left > 0) {
        const n = Math.min(left, data.length - offset);
        res.write(data.subarray(offset, offset + n));
        offset = (offset + n) % data.length;
        left -= n;
      }
    }, PACE_MS);
  }

  /** A live sliding-window playlist: no ENDLIST, the newest segment advances with wall-clock time. */
  function pacedPlaylist(): string {
    const newest = HLS_WINDOW - 1 + Math.floor((Date.now() - startedAt) / HLS_SEGMENT_MS);
    const first = newest - (HLS_WINDOW - 1);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${HLS_SEGMENT_MS / 1000}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${first > 0 ? Math.floor((first - 1) / HLS_SEGMENTS) : 0}`,
    ];
    for (let seq = first; seq <= newest; seq++) {
      if (seq > 0 && seq % HLS_SEGMENTS === 0) lines.push('#EXT-X-DISCONTINUITY'); // the loop wraps here
      lines.push(`#EXTINF:${(HLS_SEGMENT_MS / 1000).toFixed(6)},`, `/hls/seg-live-${seq}.ts`);
    }
    return lines.join('\n') + '\n';
  }

  /** The XMLTV guide, streamed chunk by chunk (gzip piped through zlib) so a huge guide is never one string. */
  async function xmltv(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams;
    if (q.get('username') !== username || q.get('password') !== password) return status(res, 403);
    if (guideMode === 'none') return status(res, 404);
    if (guideMode === 'error') return status(res, 500);
    const body = Readable.from(xmltvChunks(catalogue.live.items, now(), window));
    res.writeHead(200, { 'content-type': 'application/xml' });
    if (guideMode === 'gzip') {
      pipeline(body, createGzip(), res, () => body.destroy());
      return;
    }
    if (guideMode === 'xmltv') {
      pipeline(body, res, () => body.destroy());
      return;
    }
    // truncated and stall: send the first 300 bytes, stopping mid-element.
    let sent = 0;
    for await (const chunk of body as AsyncIterable<string>) {
      const part = chunk.slice(0, 300 - sent);
      res.write(part);
      sent += part.length;
      if (sent >= 300) break;
    }
    body.destroy();
    if (guideMode === 'truncated') {
      res.end();
      return;
    }
    await new Promise<void>((ok) => res.once('close', () => ok())); // stall: nothing more until the client goes
  }

  function tableListings(q: URLSearchParams, mode: 'short' | 'table'): unknown {
    const item = catalogue.live.items.find((i) => String(i.id) === q.get('stream_id'));
    if (!item?.epgChannelId) return { epg_listings: [] };
    const limit = Number(q.get('limit') ?? 4);
    return { epg_listings: listings(item, now(), window, timezone, mode === 'short' ? { limit } : undefined) };
  }

  async function api(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams;
    const good = q.get('username') === username && q.get('password') === password;
    const action = q.get('action');
    if (!good) return json(res, { user_info: { auth: 0 } });
    switch (action) {
      case null:
      case '':
        return json(res, {
          user_info: {
            username,
            password,
            auth: 1,
            status: 'Active',
            exp_date: String(Math.floor(Date.now() / 1000) + 30 * 86400),
            is_trial: '0',
            active_cons: String(open.size),
            created_at: '1600000000',
            max_connections: String(maxConnections),
            allowed_output_formats: ['m3u8', 'ts'],
          },
          server_info: {
            url: new URL(baseUrl).hostname,
            port: String(new URL(baseUrl).port),
            https_port: '',
            server_protocol: 'http',
            timezone,
            timestamp_now: Math.floor(now() / 1000),
            time_now: formatInZone(now(), timezone),
          },
        });
      case 'get_live_categories':
        return json(res, catalogue.live.categories.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 })));
      case 'get_vod_categories':
        return json(res, catalogue.movie.categories.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 })));
      case 'get_series_categories':
        return json(res, catalogue.series.categories.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 })));
      case 'get_live_streams':
        return streamArray(res, catalogue.live, (it, i) => ({
          num: i + 1,
          name: it.name,
          stream_type: 'live',
          stream_id: String(it.id),
          stream_icon: '',
          epg_channel_id: it.epgChannelId ?? '',
          added: '1600000000',
          category_id: it.categoryId,
          category_ids: [Number(it.categoryId)],
          tv_archive: it.archiveDays ? 1 : 0,
          tv_archive_duration: it.archiveDays ?? 0,
        }));
      case 'get_vod_streams':
        return streamArray(res, catalogue.movie, (it, i) => ({
          num: i + 1,
          name: it.name,
          stream_type: 'movie',
          stream_id: String(it.id),
          stream_icon: '',
          rating: '7.0',
          added: '1600000000',
          category_id: it.categoryId,
          container_extension: MEDIA.movie[String(it.id)]?.endsWith('.mp4') ? 'mp4' : 'mkv',
        }));
      case 'get_series':
        return streamArray(res, catalogue.series, (it, i) => ({
          num: i + 1,
          name: it.name,
          series_id: String(it.id),
          cover: '',
          rating: '7.0',
          releaseDate: '2020-01-01',
          category_id: it.categoryId,
        }));
      case 'get_series_info': {
        const id = q.get('series_id') ?? '';
        const item = catalogue.series.items.find((s) => String(s.id) === id);
        if (!item) return json(res, []);
        const episodes: Record<string, unknown[]> = {};
        for (const e of catalogue.episodes[id] ?? []) {
          (episodes[String(e.season)] ??= []).push({
            id: String(e.id),
            episode_num: e.num,
            title: e.title,
            container_extension: 'mkv',
            season: e.season,
            info: { duration_secs: 60 },
          });
        }
        return json(res, { info: { name: item.name, cover: '', rating: '7.0', category_id: item.categoryId }, episodes });
      }
      case 'get_short_epg':
        return json(res, tableListings(q, 'short'));
      case 'get_simple_data_table':
        if (opts.tableAction === 'typo') return json(res, { error: 'unknown action' });
        return json(res, opts.listings === false ? [] : tableListings(q, 'table'));
      case 'get_simple_date_table':
        return json(res, opts.listings === false || opts.tableAction !== 'typo' ? [] : tableListings(q, 'table'));
      default:
        return json(res, []);
    }
  }

  function json(res: ServerResponse, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  /** Writes a JSON array incrementally so huge catalogues never become one string. */
  async function streamArray(
    res: ServerResponse,
    kind: FakeKind,
    shape: (item: FakeKind['items'][number], index: number) => unknown,
  ): Promise<void> {
    res.writeHead(200, { 'content-type': 'application/json' });
    const items = kind.items;
    res.write('[');
    for (let i = 0; i < items.length; i += CHUNK) {
      let buf = i === 0 ? '' : ',';
      const end = Math.min(i + CHUNK, items.length);
      const parts: string[] = [];
      for (let j = i; j < end; j++) parts.push(JSON.stringify(shape(items[j]!, j)));
      buf += parts.join(',');
      if (!res.write(buf) && !res.destroyed) {
        await new Promise<void>((ok) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            ok();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
      if (res.destroyed) return;
    }
    res.end(']');
  }

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => ok());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
    openMediaConnections: () => open.size,
    refusedMediaRequests: () => refused.map((r) => ({ path: r.path, heldBy: [...r.heldBy] })),
    setCatalogue: (c) => {
      catalogue = c;
    },
    timeshiftRequests: () => timeshifts.map((t) => ({ ...t })),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // --generate <live>,<movie>,<series>,<categoriesPerKind> serves a generated catalogue.
  const gen = flag('--generate')?.split(',').map(Number);
  // --guide <channels>,<archivePercent>,<pastDays>,<futureDays>,<programmeMinutes> links the first channels to a guide.
  const guide = flag('--guide')?.split(',').map(Number);
  const generated = gen
    ? generateCatalogue({
        live: gen[0]!,
        movie: gen[1]!,
        series: gen[2]!,
        categoriesPerKind: gen[3]!,
        guideChannels: guide?.[0],
        archivePercent: guide?.[1],
      })
    : undefined;
  const defaultMedia = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');
  const fake = await startFakeXtream({
    port: flag('--port') ? Number(flag('--port')) : undefined,
    mediaDir: flag('--media') ?? defaultMedia,
    catalogue: generated ?? smallCatalogue(),
    paced: args.includes('--paced'),
    guideWindow: guide ? { pastDays: guide[2]!, futureDays: guide[3]!, programmeMinutes: guide[4]! } : undefined,
  });
  console.log(`fake xtream listening on ${fake.url} (username u, password p)`);
}
