import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Kind } from '@tv/shared';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createCurationService } from '../curation/service.ts';
import type { CurationService } from '../curation/service.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { startGeneratedFake } from '../testing/generatedFake.ts';
import { createSearch } from './search.ts';
import type { Search } from './search.ts';
import { syncCatalogue } from './sync.ts';

const KINDS: Kind[] = ['live', 'movie', 'series'];
const BUDGET_MS = 1_000; // better-sqlite3 is synchronous: every stream request waits for a search

let fake: Awaited<ReturnType<typeof startGeneratedFake>>;
let tmp: string;
let db: Db;
let providerId: number;
let curation: CurationService;
let search: Search;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-search-scale-'));
  fake = await startGeneratedFake('50000,200000,50000,400');
  db = openDb(path.join(tmp, 'scale.sqlite'));
  const providers = createProviderService({ db, userAgent: 'scale' });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId });
  curation = createCurationService({ db, now: Date.now });
  search = createSearch(db);
}, 120_000);

afterAll(() => {
  db?.close();
  fake?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Wall time of each search the route would run for `q`, per kind, and how many rows each found. */
function timeSearches(q: string): { kind: Kind; ms: number; rows: number }[] {
  return KINDS.map((kind) => {
    const { visibleIds, allVisible } = curation.resolution(providerId, kind, 1);
    const t0 = performance.now();
    const rows = search.items(providerId, kind, q, allVisible ? 'all' : visibleIds, 20).length;
    return { kind, ms: performance.now() - t0, rows };
  });
}

test('searching "the" and "a" over 300,000 items stays under 1 s per kind with every category visible', () => {
  expect(db.prepare("SELECT COUNT(*) FROM items WHERE kind = 'movie'").pluck().get()).toBe(200_000);
  for (const q of ['the', 'a']) {
    const timings = timeSearches(q);
    console.log(`SCALE search all-visible q=${q} ${timings.map((t) => `${t.kind}=${t.ms.toFixed(0)}ms`).join(' ')}`);
    for (const t of timings) {
      expect(t.rows, `${q} ${t.kind}`).toBeGreaterThan(0);
      expect(t.ms, `${q} ${t.kind}`).toBeLessThan(BUDGET_MS);
    }
  }
});

test('with one category hidden per kind (the filtered path) it stays under 1 s too', () => {
  for (const kind of KINDS) {
    const first = db.prepare('SELECT id FROM categories WHERE provider_id = ? AND kind = ? ORDER BY id LIMIT 1').pluck().get(providerId, kind);
    expect(curation.hideCategory(first as number, null)).toBe(true);
  }
  for (const q of ['the', 'a']) {
    const timings = timeSearches(q);
    console.log(`SCALE search one-hidden q=${q} ${timings.map((t) => `${t.kind}=${t.ms.toFixed(0)}ms`).join(' ')}`);
    for (const t of timings) {
      expect(t.rows, `${q} ${t.kind}`).toBeGreaterThan(0);
      expect(t.ms, `${q} ${t.kind}`).toBeLessThan(BUDGET_MS);
    }
  }
});
