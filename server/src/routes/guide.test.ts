import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { GridRow, GuideMeta, Page, Programme, WhatsOnEntry } from '@tv/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { buildApp } from '../app.ts';
import { createCatalogueRepo } from '../catalogue/repo.ts';
import { createSeriesInfoCache } from '../catalogue/seriesInfo.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { createSyncRunner } from '../catalogue/syncRunner.ts';
import { createCurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createGuideRunner } from '../guide/runner.ts';
import type { GuideRunner } from '../guide/runner.ts';
import { createGuideStore } from '../guide/store.ts';
import { visibleLiveItemIds } from '../guide/visible.ts';
import { createPersonalService } from '../personal/service.ts';
import type { PersonalService } from '../personal/service.ts';
import { createPrefsService } from '../prefs/service.ts';
import { createProviderService } from '../providers/service.ts';
import { testConfig } from '../testing/config.ts';
import { stubSessions } from '../testing/sessions.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
const NOW = NOW_MS / 1000;
const HOUR = 3600;
const DAY = 86_400;
const USER = 1;

const at = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 19).replace(/[-T:]/g, '')} +0000`;
/** Hourly programmes from three days back to two days ahead on each channel, other.uk included. */
const xmltv = (): string => {
  const channels = ['hls.uk', 'raw.uk', 'other.uk'];
  let xml = '<tv>';
  for (const c of channels) xml += `<channel id="${c}"><display-name>${c}</display-name></channel>`;
  for (const c of channels) {
    for (let t = NOW - 3 * DAY; t < NOW + 2 * DAY; t += HOUR) {
      xml += `<programme start="${at(t)}" stop="${at(t + HOUR)}" channel="${c}"><title>${c}</title></programme>`;
    }
  }
  return `${xml}</tv>`;
};

let fake: FakeXtream;
let app: FastifyInstance;
let db: Db;
let personal: PersonalService;
let guide: GuideRunner;
let providerId: number;
/** While set, an XMLTV read stops after its first programme until this resolves. */
let gate: Promise<void> | null = null;

const itemId = (remoteId: string): number =>
  db.prepare("SELECT id FROM items WHERE kind = 'live' AND remote_id = ?").pluck().get(remoteId) as number;
const categoryId = (remoteId: string): number =>
  db.prepare("SELECT id FROM categories WHERE kind = 'live' AND remote_id = ?").pluck().get(remoteId) as number;
const settle = async () => {
  for (let i = 0; i < 400 && guide.running(providerId); i++) await new Promise((r) => setTimeout(r, 25));
};
const q = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir, catalogue: smallCatalogue(), now: () => NOW_MS });
  db = openDb(':memory:');
  const config = testConfig();
  const real = createProviderService({ db, userAgent: config.defaultUserAgent });
  providerId = (await real.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: real.clientFor(providerId), providerId, kinds: ['live'] });
  // The guide runner reads a hand-written XMLTV, which gives other.uk programmes the fake's does not.
  const providers = {
    ...real,
    clientFor: (id: number) => ({
      ...real.clientFor(id),
      xmltv: async () => {
        const xml = xmltv();
        const held = gate;
        if (!held) return Readable.from([Buffer.from(xml)]);
        // The wanted channels are fixed at the first programme, so the rest waits until the test has made its pick.
        const cut = xml.indexOf('<programme', xml.indexOf('<programme') + 1);
        return Readable.from(
          (async function* () {
            yield Buffer.from(xml.slice(0, cut));
            await held;
            yield Buffer.from(xml.slice(cut));
          })(),
        );
      },
    }),
  } as typeof real;
  const curation = createCurationService({ db, now: Date.now });
  personal = createPersonalService({ db, now: Date.now });
  guide = createGuideRunner({
    db, store: createGuideStore(db), providers, now: () => NOW_MS,
    visibleLiveItemIds: (id) => visibleLiveItemIds(db, curation, id, USER),
  });
  guide.start(providerId);
  await settle();
  const catalogue = createCatalogueRepo(db);
  app = await buildApp({
    config, db, providers: real, catalogue, guide, curation, personal,
    prefs: createPrefsService(db),
    now: () => NOW_MS,
    sync: createSyncRunner({ db, providers: real }),
    seriesInfo: createSeriesInfoCache({ providers: real, catalogue }),
    sessions: stubSessions(),
  });
});

afterAll(async () => {
  await guide.stop();
  await app.close();
  await fake.close();
});

test('POST starts and GET reports', async () => {
  const post = await app.inject({ method: 'POST', url: `/api/providers/${providerId}/guide` });
  expect(post.statusCode).toBe(202);
  expect(post.json()).toEqual({ started: true });
  await settle();
  const res = await app.inject(`/api/providers/${providerId}/guide`);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ state: 'idle', source: 'xmltv', error: null });
  expect(res.json().fetchedAt).toEqual(expect.any(Number));
});

test('unknown provider is 404', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/providers/999/guide' })).statusCode).toBe(404);
  expect((await app.inject('/api/providers/999/guide')).statusCode).toBe(404);
});

describe('guide API', () => {
  const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
  const meta = async () => (await app.inject('/api/guide')).json() as GuideMeta;

  test('meta lists all, favourites and pinned chips with default prefs', async () => {
    let m = await meta();
    expect(m.providerId).toBe(providerId);
    expect(m.chips).toEqual([{ filter: 'all', label: 'All channels' }, { filter: 'favourites', label: 'Favourites' }]);
    expect(m.prefs).toEqual({ view: 'whatson', filter: 'all' });
    expect(m.range?.toSec).toBe(NOW + 2 * DAY);
    expect(m.range?.fromSec).toBeLessThan(NOW);
    expect(m.status).toMatchObject({ state: 'idle', source: 'xmltv' });

    const general = categoryId('1');
    personal.pin(USER, general);
    personal.addFavourite(USER, itemId('2'));
    m = await meta();
    expect(m.chips[2]).toEqual({ filter: `category:${general}`, label: 'UK| General' });
    expect(m.prefs).toEqual({ view: 'whatson', filter: 'favourites' });
  });

  test('prefs round-trip and an invalid stored filter falls back', async () => {
    const general = categoryId('1');
    expect((await put('/api/me/prefs/guide', { view: 'grid', filter: `category:${general}` })).statusCode).toBe(204);
    expect((await meta()).prefs).toEqual({ view: 'grid', filter: `category:${general}` });
    personal.unpin(USER, general);
    expect((await meta()).prefs).toEqual({ view: 'grid', filter: 'favourites' });
    expect((await put('/api/me/prefs/guide', { view: 'list', filter: 'all' })).statusCode).toBe(400);
    expect((await put('/api/me/prefs/guide', { view: 'grid', filter: 'bogus' })).statusCode).toBe(400);
    expect((await put('/api/me/prefs/guide', { view: 'whatson', filter: 'all' })).statusCode).toBe(204);
    expect((await meta()).prefs).toEqual({ view: 'whatson', filter: 'all' });
  });

  test("what's on now marks live entries and presents items", async () => {
    const res = await app.inject(`/api/guide/whats-on?${q({ filter: 'all' })}`);
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page<WhatsOnEntry>;
    expect(page.items.map((e) => e.item.name)).toEqual(['UK| HLS Channel', 'UK| Raw TS Channel']);
    const first = page.items[0]!;
    expect(first).toMatchObject({ live: true, catchup: true });
    expect(page.items[1]).toMatchObject({ live: true, catchup: false });
    expect(first.programme.startSec).toBe(NOW);
    expect(first.item).toMatchObject({ displayName: 'UK| HLS Channel', favourite: false, now: { startSec: NOW, stopSec: NOW + HOUR } });
    const fav = await app.inject(`/api/guide/whats-on?${q({ filter: 'favourites' })}`);
    expect((fav.json() as Page<WhatsOnEntry>).items.map((e) => e.item.id)).toEqual([itemId('2')]);
    const limited = (await app.inject(`/api/guide/whats-on?${q({ filter: 'all', limit: 1 })}`)).json() as Page<WhatsOnEntry>;
    expect(limited.items).toHaveLength(1);
    expect(limited.nextCursor).toEqual(expect.any(String));
  });

  test('category filter: visible gives items, unknown gives an empty page', async () => {
    const ok = (await app.inject(`/api/guide/whats-on?${q({ filter: `category:${categoryId('1')}` })}`)).json() as Page<WhatsOnEntry>;
    expect(ok.items).toHaveLength(2);
    const none = await app.inject(`/api/guide/whats-on?${q({ filter: 'category:99999' })}`);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ items: [], nextCursor: null });
  });

  test('past mode only returns catch-up entries with catchup=true', async () => {
    const res = await app.inject(`/api/guide/whats-on?${q({ filter: 'all', mode: 'past', from: NOW - 2 * DAY, to: NOW })}`);
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as Page<WhatsOnEntry>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((e) => e.catchup && !e.live && e.item.name === 'UK| HLS Channel')).toBe(true);
    expect(items.every((e) => e.programme.stopSec <= NOW)).toBe(true);
    const range = (
      await app.inject(`/api/guide/whats-on?${q({ filter: 'all', mode: 'range', from: NOW, to: NOW + 2 * HOUR })}`)
    ).json() as Page<WhatsOnEntry>;
    expect(range.items.map((e) => e.catchup)).toEqual([true, false, false, false]);
    expect(range.items.map((e) => [e.item.name, e.programme.startSec, e.live])).toEqual([
      ['UK| HLS Channel', NOW, true], ['UK| Raw TS Channel', NOW, true],
      ['UK| HLS Channel', NOW + HOUR, false], ['UK| Raw TS Channel', NOW + HOUR, false],
    ]);
  });

  test('range and window validation', async () => {
    const bad = async (url: string) => {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code).toBe('VALIDATION');
    };
    await bad(`/api/guide/whats-on?${q({ mode: 'range', from: NOW, to: NOW + 3 * DAY })}`);
    await bad(`/api/guide/whats-on?${q({ mode: 'range', from: NOW, to: NOW })}`);
    await bad(`/api/guide/whats-on?${q({ mode: 'past', from: NOW, to: NOW - 5 })}`);
    await bad(`/api/guide/whats-on?${q({ mode: 'sideways' })}`);
    await bad(`/api/guide/whats-on?${q({ filter: 'nope' })}`);
    await bad(`/api/guide/grid?${q({ from: NOW, to: NOW + DAY + 1 })}`);
    await bad(`/api/guide/grid?${q({ from: NOW, to: NOW })}`);
    await bad(`/api/guide/programmes?${q({ items: '1', from: NOW, to: NOW + DAY + 1 })}`);
    const many = Array.from({ length: 201 }, (_, i) => i + 1).join(',');
    await bad(`/api/guide/programmes?${q({ items: many, from: NOW, to: NOW + HOUR })}`);
  });

  test('grid pages rows and reports hasGuide', async () => {
    const win = { filter: 'all', from: NOW, to: NOW + 2 * HOUR };
    const first = (await app.inject(`/api/guide/grid?${q({ ...win, limit: 1 })}`)).json() as Page<GridRow>;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const row = first.items[0]!;
    expect(row.hasGuide).toBe(true);
    expect(row.programmes.map((p) => p.startSec)).toEqual([NOW, NOW + HOUR]);
    expect(row.item).toMatchObject({ displayName: 'UK| HLS Channel', favourite: false });
    const rest = (
      await app.inject(`/api/guide/grid?${q({ ...win, limit: 10, cursor: first.nextCursor! })}`)
    ).json() as Page<GridRow>;
    expect(rest.nextCursor).toBeNull();
    expect(rest.items.map((r) => r.item.name)).toEqual(['UK| Raw TS Channel', 'US| MPEG-2 Channel', 'Misc Dead Channel']);
    expect(rest.items.map((r) => r.hasGuide)).toEqual([true, false, false]);
    expect(rest.items[1]!.programmes).toEqual([]);
  });

  test('programmes extends the window for given items', async () => {
    const ids = [itemId('1'), itemId('3')];
    const res = await app.inject(`/api/guide/programmes?${q({ items: ids.join(','), from: NOW + HOUR, to: NOW + 3 * HOUR })}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, Programme[]>;
    expect(body[String(ids[0])]!.map((p) => p.startSec)).toEqual([NOW + HOUR, NOW + 2 * HOUR]);
    expect(body[String(ids[1])]).toEqual([]);
  });

  test('sources search and manual mapping relinks', async () => {
    const sources = (await app.inject(`/api/providers/${providerId}/guide/sources?${q({ q: 'other' })}`)).json();
    expect(sources).toEqual([{ key: 'other.uk', name: 'other.uk' }]);
    expect((await app.inject('/api/providers/999/guide/sources')).statusCode).toBe(404);

    const three = itemId('3');
    const linkOf = () => db.prepare('SELECT channel_key AS key, method FROM guide_links WHERE item_id = ?').get(three);
    const entryOf = async () =>
      ((await app.inject(`/api/guide/whats-on?${q({ filter: 'all', limit: 200 })}`)).json() as Page<WhatsOnEntry>).items.find(
        (e) => e.item.id === three,
      );
    expect(linkOf()).toBeUndefined();

    expect((await put(`/api/items/${three}/guide-source`, { key: 'other.uk' })).statusCode).toBe(204);
    expect(linkOf()).toEqual({ key: 'other.uk', method: 'manual' });
    expect(guide.running(providerId)).toBe(true);
    await settle();
    const mapped = await entryOf();
    expect(mapped?.programme).toMatchObject({ startSec: NOW, title: 'other.uk' });
    expect(mapped?.item.now?.title).toBe('other.uk');

    expect((await put(`/api/items/${three}/guide-source`, { key: null })).statusCode).toBe(204);
    expect(linkOf()).toBeUndefined();
    await settle();
    expect(await entryOf()).toBeUndefined();

    expect((await put(`/api/items/${three}/guide-source`, { key: 'missing.uk' })).statusCode).toBe(404);
    expect((await put('/api/items/99999/guide-source', { key: null })).statusCode).toBe(404);
  });

  test('a pick made during a running refresh gets its programmes from the follow-up refresh', async () => {
    const three = itemId('3');
    const entryOf = async () =>
      ((await app.inject(`/api/guide/whats-on?${q({ filter: 'all', limit: 200 })}`)).json() as Page<WhatsOnEntry>).items.find(
        (e) => e.item.id === three,
      );
    let release!: () => void;
    gate = new Promise<void>((res) => (release = res));
    try {
      guide.start(providerId);
      await new Promise((res) => setTimeout(res, 150)); // past the first programme, where wanted channels are fixed
      expect(guide.running(providerId)).toBe(true);
      expect((await put(`/api/items/${three}/guide-source`, { key: 'other.uk' })).statusCode).toBe(204);
      gate = null;
      release();
      await settle();
    } finally {
      gate = null;
      release();
    }
    expect((await entryOf())?.programme.title).toBe('other.uk');
    expect((await entryOf())?.item.now?.title).toBe('other.uk');
    expect((await put(`/api/items/${three}/guide-source`, { key: null })).statusCode).toBe(204);
    await settle();
  });

  test('over-large limits are clamped', async () => {
    const whatsOn = await app.inject(`/api/guide/whats-on?${q({ limit: 999 })}`);
    expect(whatsOn.statusCode).toBe(200);
    const grid = await app.inject(`/api/guide/grid?${q({ from: NOW, to: NOW + HOUR, limit: 999 })}`);
    expect(grid.statusCode).toBe(200);
    const sources = await app.inject(`/api/providers/${providerId}/guide/sources?${q({ limit: 999 })}`);
    expect(sources.statusCode).toBe(200);
    expect((sources.json() as unknown[]).length).toBeLessThanOrEqual(50);
  });

  test('hostile input gets a 400 or a sane page, never a 500', async () => {
    const win = { from: NOW, to: NOW + HOUR };
    const negative = Buffer.from('-5').toString('base64url');
    for (const cursor of ['!!!', negative]) {
      const whatsOn = await app.inject(`/api/guide/whats-on?${q({ cursor })}`);
      expect(whatsOn.statusCode, cursor).toBe(200);
      const grid = await app.inject(`/api/guide/grid?${q({ ...win, cursor })}`);
      expect(grid.statusCode, cursor).toBe(200);
      expect((grid.json() as Page<GridRow>).items[0]?.item.name).toBe('UK| HLS Channel');
    }
    const long = 'a'.repeat(513);
    expect((await app.inject(`/api/guide/whats-on?${q({ cursor: long })}`)).statusCode).toBe(400);
    expect((await app.inject(`/api/guide/grid?${q({ ...win, cursor: long })}`)).statusCode).toBe(400);

    const programmes = (items: string) => app.inject(`/api/guide/programmes?${q({ items, ...win })}`);
    expect((await programmes('')).statusCode).toBe(400);
    expect((await programmes('1,a')).statusCode).toBe(400);
    const dup = await programmes('1,1');
    expect(dup.statusCode).toBe(200);
    expect(Object.keys(dup.json())).toEqual(['1']);

    const sources = (extra: Record<string, string | number>) =>
      app.inject(`/api/providers/${providerId}/guide/sources?${q(extra)}`);
    expect((await sources({ limit: 0 })).statusCode).toBe(400);
    expect((await sources({ q: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await sources({ q: "%_\'" })).statusCode).toBe(200);

    const three = itemId('3');
    for (const body of [{}, { key: 5 }, { key: '' }, { key: null, extra: 1 }]) {
      expect((await put(`/api/items/${three}/guide-source`, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await put('/api/items/abc/guide-source', { key: null })).statusCode).toBe(400);
  });

  test('a non-live item is a 400', async () => {
    const movie = db
      .prepare("INSERT INTO items (provider_id, kind, remote_id, name, position, seen_at) VALUES (?, 'movie', 'mv', 'Movie', 0, 0)")
      .run(providerId).lastInsertRowid;
    expect((await put(`/api/items/${movie}/guide-source`, { key: null })).statusCode).toBe(400);
  });
});
