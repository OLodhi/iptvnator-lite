import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { PNG, startImageServer } from '../testing/imageServer.ts';
import { createLogoCache } from './cache.ts';

let server: Awaited<ReturnType<typeof startImageServer>>;
let dir: string;
let clock: number;
const now = () => clock;

beforeAll(async () => {
  server = await startImageServer();
});
afterAll(() => server.close());
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-logos-'));
  clock = Date.now();
  server.hits.length = 0;
});

const files = () => fs.readdirSync(dir);

test('caches on disk and serves the second request without fetching', async () => {
  const cache = createLogoCache({ dir, now, userAgent: 'TestAgent/1' });
  const first = await cache.get(`${server.url}/logo.png`);
  expect(first?.contentType).toBe('image/png');
  expect(fs.readFileSync(first!.path)).toEqual(PNG);
  expect(path.dirname(first!.path)).toBe(dir);
  expect(path.basename(first!.path)).toMatch(/^[0-9a-f]{64}\.png$/);
  const second = await cache.get(`${server.url}/logo.png`);
  expect(second).toEqual(first);
  expect(server.hits).toEqual([{ url: '/logo.png', userAgent: 'TestAgent/1' }]);
  expect(files()).toHaveLength(1); // no temp files left behind
});

test('refetches after the TTL', async () => {
  const cache = createLogoCache({ dir, now, ttlMs: 1000 });
  await cache.get(`${server.url}/logo.png`);
  clock += 999;
  await cache.get(`${server.url}/logo.png`);
  expect(server.hits).toHaveLength(1);
  clock += 2;
  expect(await cache.get(`${server.url}/logo.png`)).not.toBeNull();
  expect(server.hits).toHaveLength(2);
});

test('concurrent requests for one URL share a fetch', async () => {
  const cache = createLogoCache({ dir, now });
  const results = await Promise.all([1, 2, 3].map(() => cache.get(`${server.url}/logo.png`)));
  expect(new Set(results.map((r) => r?.path)).size).toBe(1);
  expect(server.hits).toHaveLength(1);
});

test('returns null for a non-image content type', async () => {
  const cache = createLogoCache({ dir, now });
  expect(await cache.get(`${server.url}/page.html`)).toBeNull();
  expect(await cache.get(`${server.url}/missing.png`)).toBeNull();
  expect(fs.existsSync(dir) ? files() : []).toEqual([]);
});

test('returns null and keeps nothing for a body over maxBytes', async () => {
  const cache = createLogoCache({ dir, now, maxBytes: 6_000 });
  expect(await cache.get(`${server.url}/big.png`)).toBeNull();
  expect(fs.existsSync(dir) ? files() : []).toEqual([]);
  expect(await createLogoCache({ dir, now, maxBytes: 20_000 }).get(`${server.url}/big.png`)).not.toBeNull();
});

test('returns null on timeout', async () => {
  const cache = createLogoCache({ dir, now, timeoutMs: 150 });
  expect(await cache.get(`${server.url}/slow.png`)).toBeNull();
  expect(fs.existsSync(dir) ? files() : []).toEqual([]);
});

test('rejects non-http(s) URLs', async () => {
  let called = 0;
  const cache = createLogoCache({
    dir,
    now,
    fetchFn: (async () => {
      called++;
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch,
  });
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a.png', 'javascript:alert(1)', '/relative.png', '']) {
    expect(await cache.get(url), url).toBeNull();
  }
  expect(called).toBe(0);
});
