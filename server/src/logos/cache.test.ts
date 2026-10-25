import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { PNG, startImageServer } from '../testing/imageServer.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogoCache, LogoBusyError } from './cache.ts';

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
  const cache = createLogoCache({ allowPrivate: true, dir, now, userAgent: 'TestAgent/1' });
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
  const cache = createLogoCache({ allowPrivate: true, dir, now, ttlMs: 1000 });
  await cache.get(`${server.url}/logo.png`);
  clock += 999;
  await cache.get(`${server.url}/logo.png`);
  expect(server.hits).toHaveLength(1);
  clock += 2;
  expect(await cache.get(`${server.url}/logo.png`)).not.toBeNull();
  expect(server.hits).toHaveLength(2);
});

test('concurrent requests for one URL share a fetch', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now });
  const results = await Promise.all([1, 2, 3].map(() => cache.get(`${server.url}/logo.png`)));
  expect(new Set(results.map((r) => r?.path)).size).toBe(1);
  expect(server.hits).toHaveLength(1);
});

test('returns null for a non-image content type', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now });
  expect(await cache.get(`${server.url}/page.html`)).toBeNull();
  expect(await cache.get(`${server.url}/missing.png`)).toBeNull();
  expect(fs.existsSync(dir) ? files() : []).toEqual([]);
});

test('returns null and keeps nothing for a body over maxBytes', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, maxBytes: 6_000 });
  expect(await cache.get(`${server.url}/big.png`)).toBeNull();
  expect(fs.existsSync(dir) ? files() : []).toEqual([]);
  expect(await createLogoCache({ allowPrivate: true, dir, now, maxBytes: 20_000 }).get(`${server.url}/big.png`)).not.toBeNull();
});

test('returns null on timeout', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, timeoutMs: 150 });
  expect(await cache.get(`${server.url}/slow.png`)).toBeNull();
  expect(fs.existsSync(dir) ? files() : []).toEqual([]);
});

test('rejects non-http(s) URLs', async () => {
  let called = 0;
  const cache = createLogoCache({
    allowPrivate: true,
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

test('a failed rename returns null and leaves no temp file', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now });
  const key = createHash('sha256').update(`${server.url}/logo.png`).digest('hex');
  fs.mkdirSync(path.join(dir, `${key}.png`)); // a directory in the way makes the final rename fail
  expect(await cache.get(`${server.url}/logo.png`)).toBeNull();
  expect(files()).toEqual([`${key}.png`]);
  // Our disk failed, not the provider: the next request tries again.
  fs.rmdirSync(path.join(dir, `${key}.png`));
  expect(await cache.get(`${server.url}/logo.png`)).not.toBeNull();
});

test('a logo whose fetch failed is not fetched again for an hour, then it is', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now });
  const missing = `${server.url}/missing.png`;
  expect(await cache.get(missing)).toBeNull();
  clock += 3_600_000 - 1;
  expect(await cache.get(missing)).toBeNull();
  expect(server.hits.map((h) => h.url)).toEqual(['/missing.png']);
  clock += 1;
  expect(await cache.get(missing)).toBeNull();
  expect(server.hits.map((h) => h.url)).toEqual(['/missing.png', '/missing.png']);
});

test('remembered failures are bounded, the oldest forgotten first', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, maxFailures: 2 });
  for (const name of ['a', 'b', 'c']) expect(await cache.get(`${server.url}/${name}.png`)).toBeNull();
  await cache.get(`${server.url}/c.png`); // still remembered
  await cache.get(`${server.url}/a.png`); // forgotten when c failed: fetched again
  expect(server.hits.map((h) => h.url)).toEqual(['/a.png', '/b.png', '/c.png', '/a.png']);
});

const put = (name: string, size: number, ageMs: number) => {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(size));
  const t = new Date(clock - ageMs);
  fs.utimesSync(path.join(dir, name), t, t);
};

test('sweep removes temp files and files older than twice the TTL, keeping fresh ones', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, ttlMs: 1000 });
  put('a.png.1.2.tmp', 10, 600_001);
  put('old.png', 20, 2001);
  put('stale.png', 30, 1500); // expired but under 2x: kept
  put('fresh.png', 40, 10);
  expect(await cache.sweep()).toEqual({ deleted: 2, bytes: 30 });
  expect(files().sort()).toEqual(['fresh.png', 'stale.png']);
});

test('sweep leaves fresh temp files alone', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, ttlMs: 1000 });
  put('writing.png.1.2.tmp', 10, 599_000); // a write may still be under way
  put('left.png.1.2.tmp', 20, 600_001);
  expect(await cache.sweep()).toEqual({ deleted: 1, bytes: 20 });
  expect(files()).toEqual(['writing.png.1.2.tmp']);
});

test('sweep evicts the oldest files first when over the cap', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, ttlMs: 10_000, maxCacheBytes: 250 });
  put('newest.png', 100, 1);
  put('oldest.png', 100, 300);
  put('middle.png', 100, 200);
  expect(await cache.sweep()).toEqual({ deleted: 1, bytes: 100 });
  expect(files().sort()).toEqual(['middle.png', 'newest.png']);
  expect(await createLogoCache({ allowPrivate: true, dir: path.join(dir, 'missing'), now }).sweep()).toEqual({ deleted: 0, bytes: 0 });
});

test('start sweeps now and daily; stop ends the timer', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // file I/O and waitFor stay real
  try {
    const cache = createLogoCache({ allowPrivate: true, dir, now, ttlMs: 1000 });
    put('old1.png', 1, 5000);
    cache.start();
    await vi.waitFor(() => expect(files()).toEqual([])); // real file I/O: wait for it
    put('old2.png', 1, 5000);
    vi.advanceTimersByTime(86_400_000);
    await vi.waitFor(() => expect(files()).toEqual([]));
    cache.stop();
    put('old3.png', 1, 5000);
    vi.advanceTimersByTime(3 * 86_400_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(files()).toEqual(['old3.png']);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('caps concurrent logo fetches at 8', async () => {
  let open = 0;
  let peak = 0;
  const held: http.ServerResponse[] = [];
  const hanging = http.createServer((_req, res) => {
    peak = Math.max(peak, ++open);
    res.on('close', () => open--);
    held.push(res);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.write(PNG.subarray(0, 8)); // started, never finished until released
  });
  await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
  try {
    const cache = createLogoCache({ allowPrivate: true, dir, now, timeoutMs: 5000 });
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => cache.get(`${base}/${i}.png`)));
    await vi.waitFor(() => expect(held).toHaveLength(8));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(held).toHaveLength(8); // the other 12 are waiting
    while (held.length < 20 || held.some((r) => !r.writableEnded)) {
      for (const res of held.filter((r) => !r.writableEnded)) res.end(PNG.subarray(8));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await all;
    expect(peak).toBeLessThanOrEqual(8);
  } finally {
    for (const r of held) r.destroy();
    hanging.close();
  }
});

const EXTENSIONS_TRIED = 8;

/** Counts finished disk lookups: each get that has to fetch does one stat per extension, then goes to the slot queue. */
function watchLookups() {
  let done = 0;
  const real = fsp.stat.bind(fsp);
  vi.spyOn(fsp, 'stat').mockImplementation(async (...args: Parameters<typeof fsp.stat>) => {
    try {
      return await real(...args);
    } finally {
      done++;
    }
  });
  return (gets: number) => vi.waitFor(() => expect(done).toBeGreaterThanOrEqual(gets * EXTENSIONS_TRIED));
}

afterEach(() => vi.restoreAllMocks());

test('answers busy beyond the queue, and never queues cached or failed logos', async () => {
  const gates: (() => void)[] = [];
  const fetchFn = (() =>
    new Promise<Response>((resolve) =>
      gates.push(() => resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } }))),
    )) as unknown as typeof fetch;
  const cache = createLogoCache({ allowPrivate: true, dir, now, fetchFn, maxConcurrent: 1, maxQueued: 1 });
  const lookedUp = watchLookups();
  const running = cache.get('http://a/1.png');
  await vi.waitFor(() => expect(gates).toHaveLength(1)); // 1 holds the slot
  const queued = cache.get('http://a/2.png');
  await lookedUp(2); // 2 has finished its disk lookup and waits for the slot
  await expect(cache.get('http://a/3.png')).rejects.toBeInstanceOf(LogoBusyError);
  expect(await cache.get('ftp://a/4.png')).toBeNull(); // rejected before the queue
  gates.shift()!();
  expect(await running).not.toBeNull();
  await vi.waitFor(() => expect(gates).toHaveLength(1)); // the queued one took the slot
  expect((await cache.get('http://a/1.png'))?.contentType).toBe('image/png'); // on disk: no wait
  gates.shift()!();
  expect(await queued).not.toBeNull();
});

test.each([
  ['times out', () => new Promise<Response>(() => undefined)],
  ['answers with a non-image', () => Promise.resolve(new Response('<html>', { headers: { 'content-type': 'text/html' } }))],
])('a fetch that %s frees its slot, and the queue goes first come first served', async (_name, first) => {
  const started: string[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    started.push(url);
    if (url.endsWith('/1.png')) {
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        void first().then(resolve);
      });
    }
    return Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  }) as unknown as typeof fetch;
  const cache = createLogoCache({ allowPrivate: true, dir, now, fetchFn, maxConcurrent: 1, timeoutMs: 50 });
  const lookedUp = watchLookups();
  const results = [cache.get('http://a/1.png')];
  await vi.waitFor(() => expect(started).toEqual(['http://a/1.png']));
  results.push(cache.get('http://a/2.png'));
  await lookedUp(2); // 2 is queued before 3 arrives
  results.push(cache.get('http://a/3.png'));
  await lookedUp(3);
  const [one, two, three] = await Promise.all(results);
  expect(one).toBeNull();
  expect(two).not.toBeNull();
  expect(three).not.toBeNull();
  expect(started).toEqual(['http://a/1.png', 'http://a/2.png', 'http://a/3.png']);
});

test('the size cap leaves young temp files alone', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, ttlMs: 10_000, maxCacheBytes: 50 });
  put('writing.png.1.2.tmp', 100, 1000); // older than the logos, but under ten minutes
  put('a.png', 100, 300);
  put('b.png', 100, 200);
  expect(await cache.sweep()).toEqual({ deleted: 2, bytes: 200 });
  expect(files()).toEqual(['writing.png.1.2.tmp']);
});

test('a large young temp file does not push logos over the cap', async () => {
  const cache = createLogoCache({ allowPrivate: true, dir, now, ttlMs: 10_000, maxCacheBytes: 150 });
  put('writing.png.1.2.tmp', 1000, 1000);
  put('a.png', 100, 300);
  expect(await cache.sweep()).toEqual({ deleted: 0, bytes: 0 });
  expect(files().sort()).toEqual(['a.png', 'writing.png.1.2.tmp']);
});

describe('redirects and private addresses', () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  const scripted = (routes: Record<string, () => Response>) => {
    const seen: string[] = [];
    const fetchFn = (async (input: string, init?: RequestInit) => {
      seen.push(input);
      expect(init?.redirect).toBe('manual');
      const route = routes[input];
      return route ? route() : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  };

  test('a redirect to a private address is refused and remembered as a failure', async () => {
    const { fetchFn, seen } = scripted({ 'http://img.example.com/a.png': () => redirect('http://127.0.0.1/x') });
    const cache = createLogoCache({ dir, now, fetchFn, lookup: publicLookup, allowPrivate: false });
    expect(await cache.get('http://img.example.com/a.png')).toBeNull();
    expect(seen).toEqual(['http://img.example.com/a.png']);
    expect(await cache.get('http://img.example.com/a.png')).toBeNull();
    expect(seen).toHaveLength(1); // remembered, not retried
  });

  test('a private first hop is refused without fetching', async () => {
    const { fetchFn, seen } = scripted({});
    const cache = createLogoCache({ dir, now, fetchFn, lookup: async () => [{ address: '10.0.0.5' }] });
    expect(await cache.get('http://nas.local/a.png')).toBeNull();
    expect(seen).toEqual([]);
  });

  test('a fourth redirect is refused', async () => {
    const { fetchFn, seen } = scripted({
      'http://a.example.com/0': () => redirect('/1'),
      'http://a.example.com/1': () => redirect('/2', 301),
      'http://a.example.com/2': () => redirect('/3', 307),
      'http://a.example.com/3': () => redirect('/4', 308),
      'http://a.example.com/4': png,
    });
    const cache = createLogoCache({ dir, now, fetchFn, lookup: publicLookup });
    expect(await cache.get('http://a.example.com/0')).toBeNull();
    expect(seen).toHaveLength(4);
  });

  test('a public redirect chain is followed', async () => {
    const { fetchFn, seen } = scripted({
      'http://a.example.com/0': () => redirect('/1'),
      'http://a.example.com/1': () => redirect('https://cdn.example.com/2', 303),
      'https://cdn.example.com/2': () => redirect('3'),
      'https://cdn.example.com/3': png,
    });
    const cache = createLogoCache({ dir, now, fetchFn, lookup: publicLookup });
    const logo = await cache.get('http://a.example.com/0');
    expect(logo?.contentType).toBe('image/png');
    expect(seen).toHaveLength(4);
  });

  test('allowPrivate skips the address check', async () => {
    const { fetchFn } = scripted({ 'http://127.0.0.1/a.png': png });
    const cache = createLogoCache({ dir, now, fetchFn, allowPrivate: true });
    expect(await cache.get('http://127.0.0.1/a.png')).not.toBeNull();
  });
});
