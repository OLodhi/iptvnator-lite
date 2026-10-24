import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { generateCatalogue, smallCatalogue } from './catalogue.ts';
import type { FakeCatalogue, FakeKind } from './catalogue.ts';

export type FakeXtreamOptions = {
  port?: number;
  username?: string;
  password?: string;
  catalogue?: FakeCatalogue;
  mediaDir: string;
  maxConnections?: number;
};

export type FakeXtream = {
  url: string;
  close(): Promise<void>;
  openMediaConnections(): number;
  /** Media requests refused because the connection limit was reached (oldest first), with the paths holding it. */
  refusedMediaRequests(): RefusedRequest[];
  setCatalogue(c: FakeCatalogue): void;
};

export type RefusedRequest = { path: string; heldBy: string[] };

// Media is mapped by stream id; the requested extension is ignored (ruling R1).
const MEDIA: Record<'live' | 'movie' | 'series', Record<string, string>> = {
  live: { '1': 'hls/index.m3u8', '2': 'raw.ts', '3': 'mpeg2.ts' },
  movie: { '1': 'movie.mkv', '2': 'movie.mp4', '3': 'hevc.mkv' },
  series: { '101': 'movie.mkv', '102': 'movie.mkv', '201': 'movie.mkv' },
};

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
};

const CHUNK = 1000;

export async function startFakeXtream(opts: FakeXtreamOptions): Promise<FakeXtream> {
  const username = opts.username ?? 'u';
  const password = opts.password ?? 'p';
  const maxConnections = opts.maxConnections ?? 1;
  const mediaDir = resolve(opts.mediaDir);
  let catalogue = opts.catalogue ?? smallCatalogue();
  const open = new Map<ServerResponse, string>(); // open media responses → request path
  const refused: RefusedRequest[] = [];
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
      const text = (await readFile(file, 'utf8'))
        .split(/\r?\n/)
        .map((l) => (l && !l.startsWith('#') ? `/hls/${basename(l)}` : l))
        .join('\n');
      res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    if (as === 'live') {
      res.writeHead(200, { 'content-type': type });
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
            time_now: new Date().toISOString().slice(0, 19).replace('T', ' '),
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
          epg_channel_id: '',
          added: '1600000000',
          category_id: it.categoryId,
          category_ids: [Number(it.categoryId)],
          tv_archive: 0,
          tv_archive_duration: 0,
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
          container_extension: it.id === 2 ? 'mp4' : 'mkv',
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
  const generated = gen
    ? generateCatalogue({ live: gen[0]!, movie: gen[1]!, series: gen[2]!, categoriesPerKind: gen[3]! })
    : undefined;
  const defaultMedia = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');
  const fake = await startFakeXtream({
    port: flag('--port') ? Number(flag('--port')) : undefined,
    mediaDir: flag('--media') ?? defaultMedia,
    catalogue: generated ?? smallCatalogue(),
  });
  console.log(`fake xtream listening on ${fake.url} (username u, password p)`);
}
