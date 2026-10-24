import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { generateCatalogue, smallCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { createCatalogueRepo } from './repo.ts';
import { createSeriesInfoCache } from './seriesInfo.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { createXtreamClient } from '../providers/xtream/client.ts';
import type { XtreamClient } from '../providers/xtream/client.ts';
import { syncCatalogue } from './sync.ts';
import { createSyncRunner } from './syncRunner.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const UA = 'test-agent';

let fake: FakeXtream;
let db: Db;
let providers: ProviderService;
let providerId: number;
let client: XtreamClient;

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.setCatalogue(smallCatalogue());
  db = openDb(':memory:');
  providers = createProviderService({ db, userAgent: UA });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  client = createXtreamClient({ serverUrl: fake.url, username: 'u', password: 'p' }, { userAgent: UA });
});

const count = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
const later = () => Date.now() + 10;

test('stores categories, items and links for every kind', async () => {
  const r = await syncCatalogue({ db, client, providerId });
  expect(r.live).toEqual({ categories: 3, items: 4, removed: 0, skippedPrune: false });
  expect(r.movie).toEqual({ categories: 2, items: 3, removed: 0, skippedPrune: false });
  expect(r.series).toEqual({ categories: 1, items: 1, removed: 0, skippedPrune: false });
  expect(count('SELECT COUNT(*) FROM items')).toBe(8);
  expect(count('SELECT COUNT(*) FROM item_categories')).toBe(8);
  expect(count("SELECT COUNT(*) FROM items_fts WHERE items_fts MATCH 'Channel'")).toBeGreaterThan(0);
});

test('a repeat sync keeps ids and does not duplicate', async () => {
  await syncCatalogue({ db, client, providerId });
  const ids = db.prepare('SELECT id FROM items ORDER BY id').pluck().all();
  await syncCatalogue({ db, client, providerId, now: later });
  expect(db.prepare('SELECT id FROM items ORDER BY id').pluck().all()).toEqual(ids);
  expect(count('SELECT COUNT(*) FROM item_categories')).toBe(8);
});

test('a later sync removes items the provider no longer lists', async () => {
  await syncCatalogue({ db, client, providerId });
  const c = smallCatalogue();
  c.movie.items = c.movie.items.filter((i) => i.id !== 3);
  fake.setCatalogue(c);
  const r = await syncCatalogue({ db, client, providerId, now: later });
  expect(r.movie.removed).toBe(1);
  expect(count("SELECT COUNT(*) FROM items WHERE kind='movie' AND remote_id='3'")).toBe(0);
  expect(count("SELECT COUNT(*) FROM items WHERE kind='movie'")).toBe(2);
  // links and the FTS entry of the removed item are gone too
  expect(count('SELECT COUNT(*) FROM item_categories WHERE item_id NOT IN (SELECT id FROM items)')).toBe(0);
  expect(count('SELECT COUNT(*) FROM item_categories')).toBe(7);
  const removedName = smallCatalogue().movie.items.find((i) => i.id === 3)!.name;
  expect(
    count('SELECT COUNT(*) FROM items_fts JOIN items ON items.id = items_fts.rowid WHERE items_fts MATCH ?', `"${removedName}"`),
  ).toBe(0);
  expect(count('SELECT COUNT(*) FROM items_fts WHERE items_fts MATCH ?', `"${removedName}"`)).toBe(0);
});

test('a later sync removes categories the provider no longer lists', async () => {
  await syncCatalogue({ db, client, providerId });
  const c = smallCatalogue();
  c.live.categories = c.live.categories.filter((x) => x.id !== '3');
  c.live.items = c.live.items.filter((i) => i.categoryId !== '3');
  fake.setCatalogue(c);
  await syncCatalogue({ db, client, providerId, now: later });
  expect(count("SELECT COUNT(*) FROM categories WHERE kind='live' AND remote_id='3'")).toBe(0);
  expect(count("SELECT COUNT(*) FROM categories WHERE kind='live'")).toBe(2);
});

test('a failed sync deletes nothing', async () => {
  await syncCatalogue({ db, client, providerId });
  const before = count('SELECT COUNT(*) FROM items');
  const failing: XtreamClient = {
    ...client,
    getCategories: (k) => client.getCategories(k),
    async *streamItems(kind) {
      let n = 0;
      for await (const it of client.streamItems(kind)) {
        if (n++ === 2) throw new Error('boom');
        yield it;
      }
    },
  };
  await expect(syncCatalogue({ db, client: failing, providerId, now: later })).rejects.toThrow('boom');
  expect(count('SELECT COUNT(*) FROM items')).toBe(before);
  expect(count('SELECT COUNT(*) FROM categories')).toBe(6);
});

type LogLine = { level: 'info' | 'warn'; m: string; o: object };
const collectingLog = (lines: LogLine[]) => ({
  info: (o: object, m: string) => void lines.push({ level: 'info', m, o }),
  warn: (o: object, m: string) => void lines.push({ level: 'warn', m, o }),
});

const tagsOf = () =>
  (db.prepare("SELECT tag FROM categories WHERE kind = 'live' ORDER BY position").all() as { tag: string | null }[]).map((r) => r.tag);
const linksOf = (kind: string, remoteId: string) =>
  db
    .prepare(
      `SELECT c.remote_id FROM item_categories ic JOIN categories c ON c.id = ic.category_id
       JOIN items i ON i.id = ic.item_id WHERE i.kind = ? AND i.remote_id = ? ORDER BY c.remote_id`,
    )
    .pluck()
    .all(kind, remoteId);

test('stores the detected style and each category tag', async () => {
  fake.setCatalogue(generateCatalogue({ live: 40, movie: 0, series: 0, categoriesPerKind: 20 }));
  await syncCatalogue({ db, client, providerId, kinds: ['live'] });
  expect(db.prepare("SELECT style, pattern FROM catalogue_styles WHERE kind = 'live'").get()).toEqual({ style: 'tagged', pattern: 'pipe' });
  const rows = db.prepare("SELECT name, tag FROM categories WHERE kind = 'live'").all() as { name: string; tag: string | null }[];
  const uk = rows.filter((r) => r.name.startsWith('UK| '));
  expect(uk.length).toBeGreaterThan(1);
  expect(uk.every((r) => r.tag === 'UK')).toBe(true);
  const untagged = rows.filter((r) => !/^\w\w\| /.test(r.name));
  expect(untagged.length).toBe(1);
  expect(untagged[0]!.tag).toBeNull();
  // a repeat sync restates the style row rather than duplicating it
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: later });
  expect(count("SELECT COUNT(*) FROM catalogue_styles WHERE kind = 'live'")).toBe(1);
});

test('a tag shared by only one category is stored as NULL', async () => {
  await syncCatalogue({ db, client, providerId, kinds: ['live'] });
  expect(tagsOf()).toEqual([null, null, null]); // UK and US each occur once
  const c = smallCatalogue();
  c.live.categories.push({ id: '4', name: 'UK| Sports' });
  fake.setCatalogue(c);
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: later });
  expect(tagsOf()).toEqual(['UK', null, null, 'UK']);
});

test('a stream listed once per category keeps every category', async () => {
  const c = smallCatalogue();
  c.live.items.push({ id: 7, name: 'UK| Twice', categoryId: '1' }, { id: 7, name: 'UK| Twice', categoryId: '2' });
  fake.setCatalogue(c);
  await syncCatalogue({ db, client, providerId, kinds: ['live'] });
  expect(linksOf('live', '7')).toEqual(['1', '2']);
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: later });
  expect(linksOf('live', '7')).toEqual(['1', '2']);
});

test('refresh with an empty kind prunes nothing', async () => {
  await syncCatalogue({ db, client, providerId });
  db.prepare("INSERT INTO favourites (user_id, provider_id, kind, remote_id, added_at) VALUES (1, ?, 'live', '1', 0)").run(providerId);
  db.prepare(
    "INSERT INTO category_rules (provider_id, user_id, kind, target_type, target, visible) VALUES (?, NULL, 'live', 'category', '3', 0)",
  ).run(providerId);
  const c = smallCatalogue();
  c.live.items = [];
  fake.setCatalogue(c);
  const lines: LogLine[] = [];
  const r = await syncCatalogue({ db, client, providerId, now: later, log: collectingLog(lines) });
  expect(r.live).toMatchObject({ items: 0, removed: 0, skippedPrune: true });
  expect(r.movie.skippedPrune).toBe(false);
  expect(count("SELECT COUNT(*) FROM items WHERE kind = 'live'")).toBe(4);
  expect(count("SELECT COUNT(*) FROM categories WHERE kind = 'live'")).toBe(3);
  expect(count("SELECT COUNT(*) FROM item_categories ic JOIN categories c ON c.id = ic.category_id WHERE c.kind = 'live'")).toBe(4);
  expect(count('SELECT COUNT(*) FROM favourites')).toBe(1);
  expect(count('SELECT COUNT(*) FROM category_rules')).toBe(1);
  expect(lines).toEqual([
    { level: 'warn', m: 'provider returned an empty list; pruning skipped', o: expect.objectContaining({ providerId, kind: 'live', itemsBefore: 4 }) },
  ]);
});

test('refresh that fails mid-stream prunes nothing', async () => {
  await syncCatalogue({ db, client, providerId });
  const links = count('SELECT COUNT(*) FROM item_categories');
  const failing: XtreamClient = {
    ...client,
    async *streamItems(kind) {
      let n = 0;
      for await (const it of client.streamItems(kind)) {
        if (n++ === 2) throw new Error('boom');
        yield it;
      }
    },
  };
  await expect(syncCatalogue({ db, client: failing, providerId, now: later })).rejects.toThrow('boom');
  expect(count('SELECT COUNT(*) FROM items')).toBe(8);
  expect(count('SELECT COUNT(*) FROM categories')).toBe(6);
  expect(count('SELECT COUNT(*) FROM item_categories')).toBe(links);
  expect(count("SELECT COUNT(*) FROM items_fts WHERE items_fts MATCH 'Channel'")).toBeGreaterThan(0);
});

test('first_seen_at is set once and never moves', async () => {
  const t1 = 1_000_000;
  const t2 = 2_000_000;
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: () => t1 });
  const c = smallCatalogue();
  c.live.categories.push({ id: '4', name: 'New' });
  fake.setCatalogue(c);
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: () => t2 });
  const rows = db.prepare("SELECT remote_id, first_seen_at, seen_at FROM categories WHERE kind = 'live' ORDER BY remote_id").all();
  expect(rows).toEqual([
    { remote_id: '1', first_seen_at: t1, seen_at: t2 },
    { remote_id: '2', first_seen_at: t1, seen_at: t2 },
    { remote_id: '3', first_seen_at: t1, seen_at: t2 },
    { remote_id: '4', first_seen_at: t2, seen_at: t2 },
  ]);
});

test('tag_changed_at moves only when the stored tag changes', async () => {
  const [t1, t2, t3, t4] = [1_000_000, 2_000_000, 3_000_000, 4_000_000];
  const rows = () =>
    db.prepare("SELECT remote_id, tag, tag_changed_at FROM categories WHERE kind = 'live' ORDER BY remote_id").all();
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: () => t1 });
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: () => t2 });
  expect(rows()).toEqual([
    { remote_id: '1', tag: null, tag_changed_at: 0 },
    { remote_id: '2', tag: null, tag_changed_at: 0 },
    { remote_id: '3', tag: null, tag_changed_at: 0 },
  ]);
  // A second UK category makes UK a tag (P2-R4): category 1 changes tag; the inserted one keeps the default.
  const c = smallCatalogue();
  c.live.categories.push({ id: '4', name: 'UK| Sports' });
  fake.setCatalogue(c);
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: () => t3 });
  expect(rows()).toEqual([
    { remote_id: '1', tag: 'UK', tag_changed_at: t3 },
    { remote_id: '2', tag: null, tag_changed_at: 0 },
    { remote_id: '3', tag: null, tag_changed_at: 0 },
    { remote_id: '4', tag: 'UK', tag_changed_at: 0 },
  ]);
  // A rename that keeps the tag leaves it alone.
  c.live.categories[0]!.name = 'UK| General HD';
  fake.setCatalogue(c);
  await syncCatalogue({ db, client, providerId, kinds: ['live'], now: () => t4 });
  expect(rows()).toEqual([
    { remote_id: '1', tag: 'UK', tag_changed_at: t3 },
    { remote_id: '2', tag: null, tag_changed_at: 0 },
    { remote_id: '3', tag: null, tag_changed_at: 0 },
    { remote_id: '4', tag: 'UK', tag_changed_at: 0 },
  ]);
});

test('a removed link is pruned after a full stream', async () => {
  await syncCatalogue({ db, client, providerId, kinds: ['live'] });
  expect(linksOf('live', '1')).toEqual(['1']);
  const c = smallCatalogue();
  c.live.items.find((i) => i.id === 1)!.categoryId = '2';
  fake.setCatalogue(c);
  const r = await syncCatalogue({ db, client, providerId, kinds: ['live'], now: later });
  expect(r.live.removed).toBe(0);
  expect(linksOf('live', '1')).toEqual(['2']);
});

test('items whose category is unknown land in Uncategorised', async () => {
  const c = smallCatalogue();
  c.live.items.push({ id: 50, name: 'Orphan', categoryId: 'nope' });
  fake.setCatalogue(c);
  await syncCatalogue({ db, client, providerId, kinds: ['live'] });
  const row = db
    .prepare(
      `SELECT c.remote_id, c.name FROM item_categories ic JOIN categories c ON c.id = ic.category_id
       JOIN items i ON i.id = ic.item_id WHERE i.remote_id = '50'`,
    )
    .get();
  expect(row).toEqual({ remote_id: '__none__', name: 'Uncategorised' });
});

test('runner reports running then idle with the result', async () => {
  const lines: LogLine[] = [];
  const runner = createSyncRunner({ db, providers, log: collectingLog(lines) });
  expect(runner.status(providerId).state).toBe('idle');
  runner.start(providerId);
  runner.start(providerId);
  expect(runner.status(providerId).state).toBe('running');
  await expect.poll(() => runner.status(providerId).state, { timeout: 10_000 }).toBe('idle');
  const s = runner.status(providerId);
  expect(s.result?.live.items).toBe(4);
  expect(s.error).toBeNull();
  expect(s.finishedAt).not.toBeNull();
  expect(providers.get(providerId)?.lastSyncedAt).not.toBeNull();

  // One info line: the provider, per-kind counts and how long it took.
  expect(lines).toEqual([
    {
      level: 'info',
      m: 'catalogue synced',
      o: { providerId, live: s.result!.live, movie: s.result!.movie, series: s.result!.series, durationMs: expect.any(Number) },
    },
  ]);
  expect((lines[0]!.o as { durationMs: number }).durationMs).toBe(s.finishedAt! - s.startedAt!);
});

test('runner logs a failure with the error redacted, and reports it redacted', async () => {
  const leaky = createProviderService({
    db,
    userAgent: UA,
    makeClient: (creds, opts) => ({
      ...createXtreamClient(creds, opts),
      getCategories: async () => {
        throw new Error(`fetch failed: ${fake.url}/player_api.php?username=someuser&password=secret&action=get_live_categories`);
      },
    }),
  });
  const lines: LogLine[] = [];
  const runner = createSyncRunner({ db, providers: leaky, log: collectingLog(lines) });
  runner.start(providerId);
  await expect.poll(() => runner.status(providerId).state, { timeout: 10_000 }).toBe('failed');

  const err = `fetch failed: ${fake.url}/player_api.php?username=***&password=***&action=get_live_categories`;
  expect(lines).toEqual([{ level: 'warn', m: 'catalogue sync failed', o: { providerId, err, durationMs: expect.any(Number) } }]);
  expect(runner.status(providerId).error).toBe(err);
  expect(JSON.stringify([lines, runner.status(providerId)])).not.toMatch(/someuser|secret/);
});

test('sync routes start a sync and report status', async () => {
  const { buildApp } = await import('../app.ts');
  const { testConfig } = await import('../testing/config.ts');
  const { stubSessions } = await import('../testing/sessions.ts');
  const { createCurationService } = await import('../curation/service.ts');
  const sync = createSyncRunner({ db, providers });
  const catalogue = createCatalogueRepo(db);
  const seriesInfo = createSeriesInfoCache({ providers, catalogue });
  const sessions = stubSessions();
  const curation = createCurationService({ db, now: Date.now });
  const app = await buildApp({ config: testConfig(), db, providers, sync, catalogue, seriesInfo, sessions, curation });
  const post = await app.inject({ method: 'POST', url: `/api/providers/${providerId}/sync` });
  expect(post.statusCode).toBe(202);
  expect(post.json()).toEqual({ started: true });
  await expect
    .poll(async () => (await app.inject(`/api/providers/${providerId}/sync`)).json().state, { timeout: 10_000 })
    .toBe('idle');
  expect((await app.inject(`/api/providers/${providerId}/sync`)).json().result.movie.items).toBe(3);
  expect((await app.inject({ method: 'POST', url: '/api/providers/999/sync' })).statusCode).toBe(404);
  await app.close();
});

test('runner records failures in status', async () => {
  const bad = createProviderService({
    db,
    userAgent: UA,
    makeClient: (creds, opts) => createXtreamClient({ ...creds, serverUrl: 'http://127.0.0.1:1' }, opts),
  });
  const runner = createSyncRunner({ db, providers: bad });
  runner.start(providerId);
  await expect.poll(() => runner.status(providerId).state, { timeout: 10_000 }).toBe('failed');
  expect(runner.status(providerId).error).toBeTruthy();
});
