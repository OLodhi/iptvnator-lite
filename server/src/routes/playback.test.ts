import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { PlayResponse } from '@tv/shared';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { buildApp } from '../app.ts';
import type { Config } from '../config.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import type { CatalogueRepo, ItemDetail } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import type { SeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createProber } from '../playback/probe.ts';
import { createSessionManager, defaultIsReady, PlaybackError } from '../playback/sessions.ts';
import type { SessionManager } from '../playback/sessions.ts';
import { resolveSourceUrl } from '../playback/sourceUrl.ts';
import { spawnFfmpeg } from '../playback/spawn.ts';
import { createProviderService } from '../providers/service.ts';
import type { ProviderService } from '../providers/service.ts';
import type { XtreamAccount, XtreamClient } from '../providers/xtream/client.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';
import type { Log } from '../util/log.ts';
import { playbackRoutes } from './playback.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const UA = 'TiviMate/4.7.0';

let fake: FakeXtream;

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue() }); // maxConnections 1
});

afterAll(async () => {
  await fake?.close();
});

type World = {
  app: FastifyInstance;
  /** The same app on a real socket, for requests that must stay open or be cut off. */
  origin: string;
  db: Db;
  providers: ProviderService;
  catalogue: CatalogueRepo;
  seriesInfo: SeriesInfoCache;
  sessions: SessionManager;
  providerId: number;
  itemId(kind: 'live' | 'movie' | 'series', remoteId: number): number;
};

type LogLine = { level: 'info' | 'warn'; m: string; o: object };

function collectingLog(lines: LogLine[]) {
  return {
    info: (o: object, m: string) => void lines.push({ level: 'info', m, o }),
    warn: (o: object, m: string) => void lines.push({ level: 'warn', m, o }),
  };
}

/** A fresh app with the fake provider added and its small catalogue synced. */
async function makeWorld(
  makeSessions: (db: Db, providers: ProviderService) => SessionManager,
  opts: { config?: Config; log?: Log } = {},
): Promise<World> {
  const config = opts.config ?? testConfig();
  const db = openDb(':memory:');
  const providers = createProviderService({ db, userAgent: config.defaultUserAgent });
  const catalogue = createCatalogueRepo(db);
  const seriesInfo = createSeriesInfoCache({ providers, catalogue });
  const sessions = makeSessions(db, providers);
  const sync = createSyncRunner({ db, providers });
  const app = await buildApp({ config, db, providers, catalogue, seriesInfo, sync, sessions, log: opts.log });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
  const lookup = db.prepare('SELECT id FROM items WHERE provider_id = ? AND kind = ? AND remote_id = ?').pluck();
  const itemId = (kind: string, remoteId: number) => {
    const id = lookup.get(providerId, kind, String(remoteId)) as number | undefined;
    if (id === undefined) throw new Error(`no ${kind} ${remoteId} in the synced catalogue`);
    return id;
  };
  return { app, origin, db, providers, catalogue, seriesInfo, sessions, providerId, itemId };
}

const playBody = (w: World, body: Record<string, unknown>) =>
  w.app.inject({ method: 'POST', url: '/api/play', payload: body });

describe('playback routes', () => {
  const sessions = stubSessions();
  const routeLogs: LogLine[] = [];
  let w: World;

  beforeAll(async () => {
    w = await makeWorld(() => sessions, { log: collectingLog(routeLogs) });
  });

  afterAll(async () => {
    await w?.app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    routeLogs.length = 0;
  });

  const started = (clientId: string, startAtSec: number): PlayResponse => ({
    sessionId: 's1',
    mode: 'hls',
    url: `/api/sessions/s1/${clientId}/index.m3u8`,
    durationSec: null,
    startAtSec,
  });

  test('POST /api/play rejects a malformed body with 400 VALIDATION', async () => {
    const start = vi.spyOn(sessions, 'start');
    const id = w.itemId('live', 1);
    const bodies = [
      {},
      { itemId: id },
      { clientId: 'A' },
      { itemId: 'one', clientId: 'A' },
      { itemId: 1.5, clientId: 'A' },
      { itemId: id, clientId: '' },
      { itemId: id, clientId: 'has space' },
      { itemId: id, clientId: '../x' },
      { itemId: id, clientId: 'x'.repeat(65) },
      { itemId: id, clientId: 'A', startAtSec: -1 },
      { itemId: id, clientId: 'A', episodeRemoteId: '' },
    ];
    for (const body of bodies) {
      const res = await playBody(w, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION' });
    }
    expect(start).not.toHaveBeenCalled();
  });

  test('POST /api/play starts a session for live, movie and episode items', async () => {
    const start = vi.spyOn(sessions, 'start').mockImplementation(async (req) => started(req.clientId, req.startAtSec));

    const live = await playBody(w, { itemId: w.itemId('live', 1), clientId: 'A' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual(started('A', 0));
    expect(start).toHaveBeenLastCalledWith({
      providerId: w.providerId,
      kind: 'live',
      contentKey: 'live:1',
      sourceUrl: `${fake.url}/live/u/p/1.m3u8`, // the fake allows m3u8, so it is preferred
      fallbackSourceUrl: `${fake.url}/live/u/p/1.ts`, // and ts too, for a playlist that turns out to be finite (R29)
      userAgent: UA,
      startAtSec: 0,
      clientId: 'A',
      quality: 'original',
    });

    const movie = await playBody(w, { itemId: w.itemId('movie', 1), clientId: 'B_2', startAtSec: 42.5 });
    expect(movie.statusCode).toBe(200);
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'movie',
        contentKey: 'movie:1',
        sourceUrl: `${fake.url}/movie/u/p/1.mkv`,
        startAtSec: 42.5,
        clientId: 'B_2',
      }),
    );

    const episode = await playBody(w, { itemId: w.itemId('series', 10), episodeRemoteId: '201', clientId: 'A' });
    expect(episode.statusCode).toBe(200);
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'episode',
        contentKey: 'episode:201',
        sourceUrl: `${fake.url}/series/u/p/201.mkv`,
      }),
    );
  });

  test('POST /api/play answers 404 for an unknown item or episode and 400 for a series without one', async () => {
    const start = vi.spyOn(sessions, 'start');
    const unknown = await playBody(w, { itemId: 987654, clientId: 'A' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'NOT_FOUND' });

    const series = w.itemId('series', 10);
    const noEpisode = await playBody(w, { itemId: series, episodeRemoteId: 'nope', clientId: 'A' });
    expect(noEpisode.statusCode).toBe(404);
    expect(noEpisode.json()).toMatchObject({ code: 'NOT_FOUND' });

    const missing = await playBody(w, { itemId: series, clientId: 'A' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'VALIDATION' });
    expect(start).not.toHaveBeenCalled();
  });

  test('POST /api/play maps playback errors to 409 and 502', async () => {
    const start = vi.spyOn(sessions, 'start');
    const body = { itemId: w.itemId('live', 1), clientId: 'A' };

    const details = { limit: 1, watchingClientIds: ['B'] };
    start.mockRejectedValueOnce(new PlaybackError('PROVIDER_CONNECTION_LIMIT', 'The provider allows 1 connection(s)', details));
    const busy = await playBody(w, body);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ code: 'PROVIDER_CONNECTION_LIMIT', message: 'The provider allows 1 connection(s)', details });

    for (const code of ['STREAM_START_TIMEOUT', 'UPSTREAM_ERROR'] as const) {
      start.mockRejectedValueOnce(new PlaybackError(code, 'nope'));
      const res = await playBody(w, body);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ code, message: 'nope' });
    }
  });

  test('session files are served with their HLS types, and nothing else is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tv-files-'));
    const dir = join(root, 'session');
    mkdirSync(dir);
    writeFileSync(join(root, 'outside.ts'), 'not a session file');
    const files: Record<string, string> = {
      'index.m3u8': 'application/vnd.apple.mpegurl',
      'seg_00000.ts': 'video/mp2t',
      'seg_00001.m4s': 'video/iso.segment',
      'init.mp4': 'video/mp4',
    };
    for (const name of [...Object.keys(files), 'notes.txt']) writeFileSync(join(dir, name), `contents of ${name}`);
    const touch = vi.spyOn(sessions, 'touch').mockImplementation((id, clientId) => id === 'sess' && clientId === 'A');
    // Deliberately naive, so the route has to refuse unsafe names itself.
    vi.spyOn(sessions, 'resolveFile').mockImplementation((id, file) => (id === 'sess' ? join(dir, file) : null));
    const get = (path: string) => w.app.inject(`/api/sessions/${path}`);

    try {
      for (const [name, type] of Object.entries(files)) {
        const res = await get(`sess/A/${name}`);
        expect(res.statusCode, name).toBe(200);
        expect(res.headers['content-type']).toBe(type);
        expect(res.body).toBe(`contents of ${name}`);
      }
      expect((await get('sess/A/index.m3u8')).headers['cache-control']).toBe('no-cache');
      expect(touch).toHaveBeenCalledWith('sess', 'A');

      expect((await get('sess/A/seg_00009.ts')).statusCode).toBe(404); // not written (or already deleted)
      expect((await get('sess/B/index.m3u8')).statusCode).toBe(404); // touch says no
      expect((await get('gone/A/index.m3u8')).statusCode).toBe(404);
      const unsafe = ['notes.txt', '..%2Foutside.ts', '..%5Coutside.ts', '%2e%2e%2foutside.ts', '..', '.m3u8', 'a%2Fb.ts', 'C%3A%5Cx.ts'];
      for (const bad of unsafe) {
        const res = await get(`sess/A/${bad}`);
        expect(res.statusCode, bad).toBe(404);
        expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('heartbeat touches the viewer and release leaves the session', async () => {
    const touch = vi.spyOn(sessions, 'touch').mockImplementation((id, clientId) => id === 'sess' && clientId === 'A');
    const release = vi.spyOn(sessions, 'release');

    expect((await w.app.inject({ method: 'POST', url: '/api/sessions/sess/A/heartbeat' })).statusCode).toBe(204);
    expect(touch).toHaveBeenLastCalledWith('sess', 'A');
    const gone = await w.app.inject({ method: 'POST', url: '/api/sessions/gone/A/heartbeat' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ code: 'NOT_FOUND' });

    expect((await w.app.inject({ method: 'DELETE', url: '/api/sessions/sess/A' })).statusCode).toBe(204);
    expect(release).toHaveBeenCalledWith('sess', 'A');
  });

  test('the direct proxy forwards Range and the provider User-Agent and mirrors only the media headers', async () => {
    const seen: { method: string; headers: IncomingHttpHeaders }[] = [];
    const upstream = createServer((req, res) => {
      seen.push({ method: req.method!, headers: req.headers });
      if (req.url!.includes('/404/')) return void res.writeHead(404).end('not here');
      if (req.url!.includes('/416/')) return void res.writeHead(416, { 'content-range': 'bytes */100' }).end();
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-length': 4,
        'content-range': 'bytes 10-13/100',
        'accept-ranges': 'bytes',
        'set-cookie': 'provider=session',
        'x-provider-secret': 'nope',
      });
      res.end(req.method === 'HEAD' ? undefined : 'abcd');
    });
    await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    let path = 'ok';
    vi.spyOn(sessions, 'touch').mockImplementation((id, clientId) => id === 'sess' && clientId === 'A');
    vi.spyOn(sessions, 'directSource').mockImplementation((id) =>
      id === 'sess' ? { url: `${origin}/movie/user/secretpass/${path}/5.mp4`, userAgent: UA } : null,
    );
    const direct = (headers: Record<string, string> = {}, method: 'GET' | 'HEAD' = 'GET') =>
      w.app.inject({ method, url: '/api/sessions/sess/A/direct', headers: { 'user-agent': 'iPhone Safari', ...headers } });

    try {
      const res = await direct({ range: 'bytes=10-13' });
      expect(res.statusCode).toBe(206);
      expect(res.body).toBe('abcd');
      expect(res.headers).toMatchObject({
        'content-type': 'video/mp4',
        'content-length': '4',
        'content-range': 'bytes 10-13/100',
        'accept-ranges': 'bytes',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-provider-secret']).toBeUndefined();
      expect(seen.at(-1)).toMatchObject({ method: 'GET', headers: { range: 'bytes=10-13', 'user-agent': UA } });

      const head = await direct({}, 'HEAD');
      expect(head.statusCode).toBe(206);
      expect(head.headers['content-length']).toBe('4');
      expect(head.body).toBe('');
      expect(seen.at(-1)).toMatchObject({ method: 'HEAD' });
      expect(seen.at(-1)!.headers.range).toBeUndefined();

      path = '416';
      const unsatisfiable = await direct({ range: 'bytes=500-' });
      expect(unsatisfiable.statusCode).toBe(416);
      expect(unsatisfiable.headers['content-range']).toBe('bytes */100');

      path = '404';
      const failed = await direct();
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toMatchObject({ code: 'UPSTREAM_ERROR' });
      expect(failed.body).not.toMatch(/secretpass|127\.0\.0\.1|not here/);
      // The provider failure reaches the server's log, redacted.
      expect(routeLogs).toEqual([
        { level: 'warn', m: 'direct stream: provider refused', o: { url: `${origin}/movie/***/***/404/5.mp4`, status: 404 } },
      ]);

      expect((await w.app.inject('/api/sessions/sess/B/direct')).statusCode).toBe(404);
      expect((await w.app.inject('/api/sessions/other/A/direct')).statusCode).toBe(404);
    } finally {
      await new Promise((ok) => upstream.close(ok));
    }
  });

  test('a viewer who leaves while the provider is still answering is not logged as a provider failure', async () => {
    const upstream = await silentUpstream();
    vi.spyOn(sessions, 'touch').mockReturnValue(true);
    vi.spyOn(sessions, 'directSource').mockReturnValue({ url: `${upstream.origin}/movie/user/secret/5.mp4`, userAgent: UA });
    try {
      const viewer = httpGet(`${w.origin}/api/sessions/sess/A/direct`);
      viewer.on('error', () => {});
      await vi.waitFor(() => expect(upstream.open()).toBe(1)); // waiting for the provider's headers
      viewer.destroy();
      await vi.waitFor(() => expect(upstream.open()).toBe(0)); // the provider request was dropped too
      await new Promise((ok) => setTimeout(ok, 50));
      expect(routeLogs.filter((l) => l.level === 'warn')).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  test("ending or replacing a viewer's session cuts their in-flight direct request first", async () => {
    const upstream = await silentUpstream();
    vi.spyOn(sessions, 'touch').mockReturnValue(true);
    vi.spyOn(sessions, 'directSource').mockReturnValue({ url: `${upstream.origin}/movie/user/secret/5.mp4`, userAgent: UA });
    // What the provider has open by the time the session manager is called. Without the cut, the old
    // request would stay open until the proxy's 10 s re-check.
    const openSoon = async (n: number) => {
      await vi.waitFor(() => expect(upstream.open()).toBe(n), { timeout: 500 }).catch(() => {});
      return upstream.open();
    };
    const openAtRelease: number[] = [];
    vi.spyOn(sessions, 'release').mockImplementation(async () => void openAtRelease.push(await openSoon(0)));
    const openAtStart: number[] = [];
    vi.spyOn(sessions, 'start').mockImplementation(async (req) => {
      openAtStart.push(await openSoon(1));
      return started(req.clientId, 0);
    });
    try {
      // DELETE: the viewer still waiting for the provider is told the session is gone.
      const waiting = viewer(`${w.origin}/api/sessions/sess/A/direct`);
      await vi.waitFor(() => expect(upstream.open()).toBe(1));
      expect((await w.app.inject({ method: 'DELETE', url: '/api/sessions/sess/A' })).statusCode).toBe(204);
      expect(openAtRelease).toEqual([0]);
      expect(await waiting.status).toBe(404);

      // POST /api/play for the same viewer: their old direct request is cut; other viewers' are not.
      const old = viewer(`${w.origin}/api/sessions/sess/A/direct`);
      const other = viewer(`${w.origin}/api/sessions/sess/B/direct`);
      await vi.waitFor(() => expect(upstream.open()).toBe(2));
      expect((await playBody(w, { itemId: w.itemId('live', 1), clientId: 'A' })).statusCode).toBe(200);
      expect(openAtStart).toEqual([1]);
      expect(await old.status).toBe(404);

      other.req.destroy();
      await vi.waitFor(() => expect(upstream.open()).toBe(0));
      expect(routeLogs.filter((l) => l.level === 'warn')).toEqual([]);
    } finally {
      await upstream.close();
    }
  });
});

/** A viewer's GET that stays open until answered; `status` is -1 if the connection fails instead. */
function viewer(url: string): { req: ClientRequest; status: Promise<number> } {
  let req!: ClientRequest;
  const status = new Promise<number>((ok) => {
    req = httpGet(url, (res) => {
      ok(res.statusCode!);
      res.resume();
    });
    req.on('error', () => ok(-1));
  });
  return { req, status };
}

/** A provider stand-in that accepts requests but never answers; `open()` counts requests still connected. */
async function silentUpstream() {
  let open = 0;
  const server = createServer((_req, res) => {
    open++;
    res.once('close', () => open--);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    open: () => open,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

describe('resolveSourceUrl', () => {
  const item = (over: Partial<ItemDetail>): ItemDetail => ({
    id: 5,
    providerId: 3,
    kind: 'live',
    name: 'x',
    logoUrl: null,
    catchupDays: null,
    year: null,
    rating: null,
    remoteId: '77',
    containerExt: null,
    ...over,
  });
  const client = {
    liveUrl: (id: string, format: string) => `live/${id}.${format}`,
    movieUrl: (id: string, ext: string) => `movie/${id}.${ext}`,
    episodeUrl: (id: string, ext: string) => `series/${id}.${ext}`,
  } as unknown as XtreamClient;
  const deps = (it: ItemDetail, account: Partial<XtreamAccount> | null) => ({
    catalogue: { getItem: (id: number) => (id === it.id ? it : undefined) } as unknown as CatalogueRepo,
    seriesInfo: {
      getEpisode: async (_itemId: number, ep: string) =>
        ep === '9' ? { remoteId: '9', containerExt: 'avi', durationSec: null } : undefined,
    } as unknown as SeriesInfoCache,
    providers: {
      clientFor: () => client,
      account: () => (account ? { status: 'Active', maxConnections: 1, expiresAt: null, allowedOutputFormats: [], ...account } : null),
    } as unknown as ProviderService,
  });

  test('live prefers m3u8 only when the provider allows it', async () => {
    const req = { itemId: 5, clientId: 'A' };
    const live = item({ kind: 'live' });
    const m3u8 = await resolveSourceUrl(deps(live, { allowedOutputFormats: ['ts', 'm3u8'] }), req);
    expect(m3u8).toStrictEqual({
      providerId: 3,
      kind: 'live',
      contentKey: 'live:77',
      sourceUrl: 'live/77.m3u8',
      fallbackSourceUrl: 'live/77.ts', // R29: in case the playlist turns out to be finite
    });
    expect((await resolveSourceUrl(deps(live, { allowedOutputFormats: ['ts'] }), req)).sourceUrl).toBe('live/77.ts');
    expect((await resolveSourceUrl(deps(live, null), req)).sourceUrl).toBe('live/77.ts');
  });

  test('a live fallback is offered only for an m3u8 primary when the provider also allows ts', async () => {
    const req = { itemId: 5, clientId: 'A' };
    const live = item({ kind: 'live' });
    const m3u8Only = await resolveSourceUrl(deps(live, { allowedOutputFormats: ['m3u8'] }), req);
    expect(m3u8Only.sourceUrl).toBe('live/77.m3u8');
    expect(m3u8Only).not.toHaveProperty('fallbackSourceUrl');
    expect(await resolveSourceUrl(deps(live, { allowedOutputFormats: ['ts'] }), req)).not.toHaveProperty('fallbackSourceUrl');
    expect(await resolveSourceUrl(deps(live, null), req)).not.toHaveProperty('fallbackSourceUrl');
    const anyFormats = { allowedOutputFormats: ['ts', 'm3u8'] };
    const movie = await resolveSourceUrl(deps(item({ kind: 'movie' }), anyFormats), req);
    expect(movie).not.toHaveProperty('fallbackSourceUrl');
    const ep = await resolveSourceUrl(deps(item({ kind: 'series' }), anyFormats), { ...req, episodeRemoteId: '9' });
    expect(ep).not.toHaveProperty('fallbackSourceUrl');
  });

  test('movies default to mp4 and episodes use their own container', async () => {
    const movie = await resolveSourceUrl(deps(item({ kind: 'movie' }), null), { itemId: 5, clientId: 'A' });
    expect(movie).toStrictEqual({ providerId: 3, kind: 'movie', contentKey: 'movie:77', sourceUrl: 'movie/77.mp4' });
    const mkv = await resolveSourceUrl(deps(item({ kind: 'movie', containerExt: 'mkv' }), null), { itemId: 5, clientId: 'A' });
    expect(mkv.sourceUrl).toBe('movie/77.mkv');
    const ep = await resolveSourceUrl(deps(item({ kind: 'series' }), null), { itemId: 5, episodeRemoteId: '9', clientId: 'A' });
    expect(ep).toStrictEqual({ providerId: 3, kind: 'episode', contentKey: 'episode:9', sourceUrl: 'series/9.avi' });
  });
});

const ffmpegPath = process.env.TV_FFMPEG_PATH;
const ffprobePath = process.env.TV_FFPROBE_PATH;

describe.skipIf(!ffmpegPath || !ffprobePath)('playback with real FFmpeg', { timeout: 30_000 }, () => {
  const config = testConfig();
  const logs: string[] = [];
  const log = {
    info: (o: object, m: string) => void logs.push(JSON.stringify({ m, ...o })),
    warn: (o: object, m: string) => void logs.push(JSON.stringify({ m, ...o })),
  };
  const playing: { sessionId: string; clientId: string }[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'tv-playback-'));
  let w: World;

  beforeAll(async () => {
    if (!existsSync(join(mediaDir, 'hevc.mkv'))) {
      throw new Error('Fake media is missing. Run: npm run make-media -w @tv/fake-xtream (needs TV_FFMPEG_PATH)');
    }
    w = await makeWorld(
      (db, providers) =>
        createSessionManager({
          ffmpegPath: config.ffmpegPath,
          transcodeDir: config.transcodeDir,
          spawn: spawnFfmpeg(log),
          probe: createProber({ ffprobePath: config.ffprobePath, db }).probe,
          transcodeInterlaced: false,
          maxConnections: (id) => providers.account(id)?.maxConnections ?? null,
          isReady: defaultIsReady,
          now: Date.now,
          liveIdleMs: 20_000,
          vodIdleMs: 60_000,
          readyTimeoutMs: 5_000,
          stallTimeoutMs: 20_000,
          maxRestarts: 3,
          log,
        }),
      { config, log },
    );
  }, 30_000);

  afterEach(async () => {
    for (const p of playing.splice(0)) await w.sessions.release(p.sessionId, p.clientId);
  });

  afterAll(async () => {
    await w?.sessions.stopAll(); // no FFmpeg outlives the suite
    await w?.app.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  async function play(body: { itemId: number; clientId: string; episodeRemoteId?: string }) {
    const res = await playBody(w, body);
    if (res.statusCode === 200) playing.push({ sessionId: res.json().sessionId, clientId: body.clientId });
    return res;
  }

  async function playOk(body: { itemId: number; clientId: string; episodeRemoteId?: string }): Promise<PlayResponse> {
    const res = await play(body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  /** The first segment the playlist lists, as a server path resolved against the playlist's own URL. */
  function firstSegment(playlist: string, playlistUrl: string): string {
    const line = playlist.split(/\r?\n/).find((l) => l !== '' && !l.startsWith('#'));
    if (!line) throw new Error(`playlist lists no segments:\n${playlist}`);
    return new URL(line, `http://server${playlistUrl}`).pathname;
  }

  function codecs(bytes: Buffer): { video?: string; audio?: string } {
    const file = join(scratch, `probe-${Date.now()}.bin`);
    writeFileSync(file, bytes);
    const out = execFileSync(ffprobePath!, ['-v', 'error', '-print_format', 'json', '-show_streams', file], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const streams = (JSON.parse(out) as { streams: { codec_type: string; codec_name: string }[] }).streams;
    return {
      video: streams.find((s) => s.codec_type === 'video')?.codec_name,
      audio: streams.find((s) => s.codec_type === 'audio')?.codec_name,
    };
  }

  test('plays an HLS live channel by stream copy', async () => {
    const r = await playOk({ itemId: w.itemId('live', 1), clientId: 'A' });
    expect(r).toMatchObject({
      mode: 'hls',
      durationSec: null,
      startAtSec: 0,
      url: expect.stringMatching(/^\/api\/sessions\/[\w-]+\/A\/index\.m3u8$/),
    });
    const pl = await w.app.inject(r.url);
    expect(pl.statusCode).toBe(200);
    expect(pl.headers['content-type']).toContain('mpegurl');
    const seg = await w.app.inject(firstSegment(pl.body, r.url));
    expect(seg.statusCode).toBe(200);
    expect(seg.headers['content-type']).toBe('video/mp2t');
    expect(codecs(seg.rawPayload)).toEqual({ video: 'h264', audio: 'aac' });
    // Copied, not re-encoded: the source encoder's settings (2 Mb/s ABR, not our CRF 21) are still in the stream.
    expect(seg.rawPayload.toString('latin1')).toContain('bitrate=2000');
  });

  test('transcodes an MPEG-2 channel into H.264 and AAC', async () => {
    const r = await playOk({ itemId: w.itemId('live', 3), clientId: 'A' });
    expect(r.mode).toBe('hls');
    const pl = await w.app.inject(r.url);
    const seg = await w.app.inject(firstSegment(pl.body, r.url));
    expect(seg.statusCode).toBe(200);
    expect(codecs(seg.rawPayload)).toEqual({ video: 'h264', audio: 'aac' });
  });

  test('remuxes an MKV movie to HLS and serves an MP4 movie directly with ranges', async () => {
    const mkv = await playOk({ itemId: w.itemId('movie', 1), clientId: 'A' });
    expect(mkv.mode).toBe('hls');
    expect(mkv.durationSec).toBeCloseTo(60, 0);
    expect((await w.app.inject(mkv.url)).statusCode).toBe(200);

    const mp4 = await playOk({ itemId: w.itemId('movie', 2), clientId: 'A' });
    expect(mp4).toMatchObject({ mode: 'direct', url: `/api/sessions/${mp4.sessionId}/A/direct` });
    const file = join(mediaDir, 'movie.mp4');
    const size = statSync(file).size;
    const part = await w.app.inject({ url: mp4.url, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(100);
    expect(part.rawPayload.equals(readFileSync(file).subarray(0, 100))).toBe(true);
    expect(part.headers).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': '100',
      'content-range': `bytes 0-99/${size}`,
      'accept-ranges': 'bytes',
    });
    const head = await w.app.inject({ method: 'HEAD', url: mp4.url });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(size));

    // Starting the MP4 replaced A's MKV session.
    expect((await w.app.inject(mkv.url)).statusCode).toBe(404);
  });

  test('plays an HEVC movie as fMP4 HLS', async () => {
    const r = await playOk({ itemId: w.itemId('movie', 3), clientId: 'A' });
    expect(r.mode).toBe('hls');
    const pl = (await w.app.inject(r.url)).body;
    expect(pl).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(pl).toMatch(/^seg_\d+\.m4s$/m);
    const init = await w.app.inject(r.url.replace(/index\.m3u8$/, 'init.mp4'));
    expect(init.statusCode).toBe(200);
    expect(init.headers['content-type']).toBe('video/mp4');
    const seg = await w.app.inject(firstSegment(pl, r.url));
    expect(seg.statusCode).toBe(200);
    expect(seg.headers['content-type']).toBe('video/iso.segment');
  });

  test('plays a series episode', async () => {
    const r = await playOk({ itemId: w.itemId('series', 10), episodeRemoteId: '101', clientId: 'A' });
    expect(r.mode).toBe('hls');
    expect((await w.app.inject(r.url)).statusCode).toBe(200);
  });

  test('switches live channel on a one-connection provider', async () => {
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, fake.openMediaConnections());
    }, 1);
    try {
      await playOk({ itemId: w.itemId('live', 1), clientId: 'A' });
      // Switch while channel 1's FFmpeg (or its restart, since the fake's input is finite) holds the one connection.
      await vi.waitFor(() => expect(fake.openMediaConnections()).toBeGreaterThanOrEqual(1), { timeout: 8_000, interval: 2 });
      const peakOnChannel1 = peak;
      const refusedBefore = fake.refusedMediaRequests().length;
      await playOk({ itemId: w.itemId('live', 2), clientId: 'A' });

      expect(peakOnChannel1).toBe(1); // HLS playlist and segment fetches count against the limit
      expect(peak).toBe(1);
      // The fake refuses whatever would go over its limit, so the real check is what it refused, and why.
      // FFmpeg's HLS reader prefetches the next segment on a second connection to the same channel and
      // copes with the refusal. A request refused because the other channel still held the connection
      // would mean the switch overlapped.
      expect(crossStreamRefusals(refusedBefore)).toEqual([]);
    } finally {
      clearInterval(sampler);
    }
  });

  test('reads an HLS live input over one connection, so a strict one-stream provider never refuses it', async () => {
    const refusedBefore = fake.refusedMediaRequests().length;
    const r = await playOk({ itemId: w.itemId('live', 1), clientId: 'A' });
    // Keep the session alive while FFmpeg reads the whole (finite, ~30 s) input, which it does within seconds.
    const until = Date.now() + 7_000;
    while (Date.now() < until) {
      expect((await w.app.inject(r.url)).statusCode).toBe(200);
      await new Promise((ok) => setTimeout(ok, 250));
    }
    const refused = fake.refusedMediaRequests().slice(refusedBefore).filter((x) => contentOf(x.path) === 'live/1');
    expect(refused).toEqual([]);
  });

  // Ruling R31: AVPlayer stops a live stream whose playlist shows ENDLIST, so the relaunch gap must not.
  test("a live playlist never shows ENDLIST, even after FFmpeg exits at the end of its input", async () => {
    const r = await playOk({ itemId: w.itemId('live', 1), clientId: 'A' });
    // The fake's live input is finite (~30 s), and FFmpeg reads it within seconds, then exits and is relaunched.
    const exited = () => logs.some((l) => l.startsWith('{"m":"ffmpeg exited') && l.includes(r.sessionId));
    let exitedAt: number | null = null;
    const giveUpAt = Date.now() + 15_000;
    while (Date.now() < giveUpAt) {
      const pl = await w.app.inject(r.url);
      expect(pl.statusCode).toBe(200);
      expect(pl.body).not.toContain('#EXT-X-ENDLIST');
      if (exitedAt === null && exited()) exitedAt = Date.now();
      if (exitedAt !== null && Date.now() - exitedAt > 1_500) break; // past the 1 s backoff and into the relaunch
      await new Promise((ok) => setTimeout(ok, 100));
    }
    expect(exitedAt, 'ffmpeg should have exited at the end of its input').not.toBeNull();
  });

  test('switches from a direct movie that is still streaming to live on a one-connection provider', async () => {
    const movie = await playOk({ itemId: w.itemId('movie', 2), clientId: 'A' });
    expect(movie.mode).toBe('direct');
    // Like Safari's open `bytes=X-` request: the movie holds the provider's only connection.
    const held = await openPaused(w.origin + movie.url);
    await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(1));
    const refusedBefore = fake.refusedMediaRequests().length;

    const live = await playOk({ itemId: w.itemId('live', 1), clientId: 'A' });
    expect(live.mode).toBe('hls');
    expect(crossStreamRefusals(refusedBefore)).toEqual([]);
    expect(await drain(held.res)).toBeLessThan(statSync(join(mediaDir, 'movie.mp4')).size);
  });

  test('releasing a direct session cuts its open stream straight away', async () => {
    const movie = await playOk({ itemId: w.itemId('movie', 2), clientId: 'A' });
    const held = await openPaused(w.origin + movie.url);
    await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(1));

    const res = await w.app.inject({ method: 'DELETE', url: `/api/sessions/${movie.sessionId}/A` });
    expect(res.statusCode).toBe(204);
    // Not left for the proxy's 10 s re-check.
    await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(0), { timeout: 1_000 });
    await drain(held.res);
  });

  test('dead channel fails cleanly', async () => {
    const res = await play({ itemId: w.itemId('live', 999), clientId: 'A' });
    expect(res.statusCode).toBe(502);
    expect(['STREAM_START_TIMEOUT', 'UPSTREAM_ERROR']).toContain(res.json().code);
    expect(readdirSync(config.transcodeDir)).toEqual([]);
  });

  test('session URLs are server-relative and contain no credentials', async () => {
    const hls = await play({ itemId: w.itemId('live', 1), clientId: 'A' });
    expect(hls.statusCode).toBe(200);
    const playlist = await w.app.inject(hls.json().url);
    expect(playlist.statusCode).toBe(200);
    const direct = await play({ itemId: w.itemId('movie', 2), clientId: 'A' });
    expect(direct.statusCode).toBe(200);
    for (const text of [hls.body, direct.body, playlist.body]) {
      expect(text).not.toContain(fake.url);
      expect(text).not.toMatch(/https?:|127\.0\.0\.1|\/u\/p\//);
    }
    for (const r of [hls.json(), direct.json()] as PlayResponse[]) expect(r.url).toMatch(/^\/api\/sessions\//);
    // Nothing logged so far (FFmpeg's stderr included) carries the provider's credentials.
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toMatch(/\/u\/p\/|password=p/);
  });

  test('rejects path traversal in file names', async () => {
    const r = await playOk({ itemId: w.itemId('live', 1), clientId: 'A' });
    const base = r.url.replace(/index\.m3u8$/, '');
    const traversals = ['..%2F..%2Fx', '..%2Findex.m3u8', '..%5C..%5Cx', '%2e%2e%2f%2e%2e%2fx', '..', `..%2F..%2F${r.sessionId}%2FA%2Findex.m3u8`];
    for (const bad of traversals) expect((await w.app.inject(base + bad)).statusCode, bad).toBe(404);
    expect((await w.app.inject(r.url)).statusCode).toBe(200);
  });

  test('the direct proxy lets go of the provider when the viewer leaves, the session ends or the server stops', async () => {
    // A real socket (inject buffers whole bodies) and a fast session re-check instead of every 10 s.
    const proxy = Fastify();
    const { catalogue, seriesInfo, providers, sessions } = w;
    await proxy.register(
      playbackRoutes({ catalogue, seriesInfo, providers, sessions, log, userAgent: UA, touchIntervalMs: 100 }),
      { prefix: '/api' },
    );
    await proxy.listen({ port: 0, host: '127.0.0.1' });
    const origin = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
    const size = statSync(join(mediaDir, 'movie.mp4')).size;
    let closed = false;
    try {
      const r = await playOk({ itemId: w.itemId('movie', 2), clientId: 'A' });

      // The viewer goes away mid-movie: the upstream request is aborted.
      const left = await openPaused(origin + r.url);
      await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(1));
      left.req.destroy();
      await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(0));

      // The session ends while a response is streaming: the upstream is aborted and the response cut short.
      const cut = await openPaused(origin + r.url);
      await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(1));
      await w.sessions.release(r.sessionId, 'A');
      await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(0));
      const received = await drain(cut.res);
      expect(cut.res.complete).toBe(false);
      expect(received).toBeLessThan(size);

      // Shutting down doesn't wait for a movie that is still streaming.
      const again = await playOk({ itemId: w.itemId('movie', 2), clientId: 'A' });
      const streaming = await openPaused(origin + again.url);
      await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(1));
      await proxy.close();
      closed = true;
      await vi.waitFor(() => expect(fake.openMediaConnections()).toBe(0));
      expect(await drain(streaming.res)).toBeLessThan(size);
    } finally {
      if (!closed) await proxy.close();
    }
  });
});

/** Which of the fake's streams a media path belongs to: `live/<n>`, `movie/<n>`, ...; `/hls/...` is live channel 1. */
function contentOf(path: string): string {
  if (path.startsWith('/hls/')) return 'live/1';
  const m = /^\/(live|movie|series)\/[^/]+\/[^/]+\/(\d+)/.exec(path);
  return m ? `${m[1]}/${m[2]}` : path;
}

/** Requests the fake refused (since `from`) because a *different* stream held the connection. */
function crossStreamRefusals(from: number) {
  return fake
    .refusedMediaRequests()
    .slice(from)
    .filter((r) => r.heldBy.some((held) => contentOf(held) !== contentOf(r.path)));
}

/** GETs a URL, reads the first chunk, then stops reading so the body backs up to the provider. */
function openPaused(url: string): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  return new Promise((ok, fail) => {
    const req = httpGet(url, (res) => {
      if (res.statusCode !== 200) return fail(new Error(`status ${res.statusCode}`));
      res.on('error', () => {}); // cut short on purpose by the tests
      res.once('data', () => {
        res.pause();
        ok({ req, res });
      });
    });
    req.on('error', () => {}); // destroyed on purpose by the tests
  });
}

/** Reads the rest of a response until its connection closes; resolves with the bytes received. */
function drain(res: IncomingMessage): Promise<number> {
  return new Promise((ok) => {
    let bytes = 0;
    if (res.destroyed) return ok(bytes); // already cut off
    res.on('data', (c: Buffer) => {
      bytes += c.length;
    });
    res.once('close', () => ok(bytes));
    res.resume();
  });
}
