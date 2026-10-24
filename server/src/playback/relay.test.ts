import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startUpstreamRelay } from './relay.ts';
import type { UpstreamRelay } from './relay.ts';

// Big enough that a reader who stops reading holds the provider's response open.
const SIZE = 16 * 1024 * 1024;
const MEDIA = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) MEDIA[i] = i % 251;
const UA = 'TiviMate/4.7.0';

type LogLine = { m: string; o: object };

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let relay: UpstreamRelay;
let logs: LogLine[];

beforeEach(async () => {
  upstream = await startUpstream();
  logs = [];
  relay = await startUpstreamRelay({
    log: { info: (o, m) => void logs.push({ m, o }), warn: (o, m) => void logs.push({ m, o }) },
    retryDelaysMs: [10, 10],
  });
});

afterEach(async () => {
  await relay.close();
  await upstream.close();
});

const source = () => ({ url: `${upstream.origin}/movie/user/pass/1.mkv`, userAgent: UA });

test('serves the provider through a loopback URL, passing Range through', async () => {
  const { url } = relay.register(source());
  expect(url.startsWith('http://127.0.0.1:')).toBe(true);
  expect(url.endsWith('/1.mkv')).toBe(true);
  expect(url).not.toMatch(/user|pass/);

  const res = await get(url, { range: 'bytes=10-19', 'user-agent': 'Lavf/62' });
  expect(res.status).toBe(206);
  expect(res.headers).toMatchObject({
    'content-range': `bytes 10-19/${SIZE}`,
    'content-length': '10',
    'content-type': 'video/x-matroska',
    'accept-ranges': 'bytes',
  });
  expect(res.headers['x-provider']).toBeUndefined();
  expect(res.body.equals(MEDIA.subarray(10, 20))).toBe(true);
  // The provider sees the registered User-Agent, not FFmpeg's.
  expect(upstream.lastRequest()).toMatchObject({
    method: 'GET',
    // fetch() adds its own `identity` to a range request, so the header can carry it twice.
    headers: { range: 'bytes=10-19', 'user-agent': UA, 'accept-encoding': expect.stringMatching(/^identity(, identity)?$/) },
  });

  const head = await get(url, {}, 'HEAD');
  expect(head.status).toBe(200);
  expect(head.headers['content-length']).toBe(String(SIZE));
  expect(head.body.length).toBe(0);
  expect(upstream.lastRequest().method).toBe('HEAD');
});

test('a new request aborts the previous provider request before opening the next', async () => {
  const { url } = relay.register(source());
  const a = await openPaused(url, 'bytes=0-');
  await vi.waitFor(() => expect(upstream.open()).toBe(1)); // A holds the provider's connection

  const b = await get(url, { range: 'bytes=100-199' });
  expect(b.status).toBe(206);
  expect(b.headers['content-range']).toBe(`bytes 100-199/${SIZE}`);
  expect(b.body.equals(MEDIA.subarray(100, 200))).toBe(true);

  const ended = await within(2_000, endOf(a));
  expect(ended.complete).toBe(false); // cut off, not finished
  expect(upstream.maxOpen()).toBe(1);
});

test('retries a connection-limit refusal', async () => {
  upstream.refuseNext(1);
  const res = await get(relay.register(source()).url, { range: 'bytes=0-9' });
  expect(res.status).toBe(206);
  expect(res.body.equals(MEDIA.subarray(0, 10))).toBe(true);
  expect(upstream.requests()).toBe(2);
  expect(logs).toEqual([]); // the retry worked: nothing to report
});

test('passes the refusal on once the retries run out', async () => {
  upstream.refuseNext(Infinity);
  const res = await get(relay.register(source()).url);
  expect(res.status).toBe(403);
  expect(res.body.length).toBe(0);
  expect(upstream.requests()).toBe(3);
  // One warning for the whole sequence, without the credentials.
  expect(logs).toEqual([{ m: 'relay: provider refused', o: { url: `${upstream.origin}/movie/***/***/1.mkv`, status: 403 } }]);
});

test('unregister aborts the provider request, then the path 404s', async () => {
  const reg = relay.register(source());
  const a = await openPaused(reg.url, 'bytes=0-');
  await vi.waitFor(() => expect(upstream.open()).toBe(1));

  await reg.unregister();
  // The relay's side is closed by now; the provider notices a moment later (the lag the retries cover).
  await vi.waitFor(() => expect(upstream.open()).toBe(0), { timeout: 500, interval: 5 });
  expect((await within(2_000, endOf(a))).complete).toBe(false);
  expect((await get(reg.url)).status).toBe(404);
  expect(upstream.requests()).toBe(1);
});

test('an unknown path is 404', async () => {
  const { url } = relay.register(source());
  const { origin, pathname } = new URL(url);
  for (const path of ['/', '/1.mkv', `/${randomUUID()}/1.mkv`, `${pathname}x`, pathname.replace('/1.mkv', '/2.mkv')]) {
    expect((await get(origin + path)).status, path).toBe(404);
  }
  expect(upstream.requests()).toBe(0);
});

test('close() aborts in-flight provider requests and stops listening', async () => {
  const { url } = relay.register(source());
  const a = await openPaused(url, 'bytes=0-');
  await vi.waitFor(() => expect(upstream.open()).toBe(1));

  await relay.close();
  await vi.waitFor(() => expect(upstream.open()).toBe(0), { timeout: 500, interval: 5 });
  expect((await within(2_000, endOf(a))).complete).toBe(false);
  await expect(get(url)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

/** A provider stand-in serving MEDIA with Range support. It counts open responses and can refuse requests with 403. */
async function startUpstream() {
  let open = 0;
  let maxOpen = 0;
  let requests = 0;
  let refuse = 0;
  let last: { method: string; headers: IncomingHttpHeaders } | null = null;
  const server = createServer((req, res) => {
    requests++;
    last = { method: req.method!, headers: req.headers };
    if (refuse > 0) {
      refuse--;
      return void res.writeHead(403).end();
    }
    open++;
    maxOpen = Math.max(maxOpen, open);
    res.once('close', () => open--);
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : SIZE - 1;
    const headers: OutgoingHttpHeaders = {
      'content-type': 'video/x-matroska',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'x-provider': 'stays on the server',
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${SIZE}`;
    res.writeHead(range ? 206 : 200, headers);
    // Streamed in chunks, honouring backpressure, so a reader who stops reading keeps the response open.
    pipeline(Readable.from(chunks(MEDIA.subarray(start, end + 1))), res, () => {});
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    open: () => open,
    maxOpen: () => maxOpen,
    requests: () => requests,
    lastRequest: () => last!,
    /** Refuses the next `n` requests with 403. */
    refuseNext(n: number) {
      refuse = n;
    },
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function* chunks(bytes: Buffer): Generator<Buffer> {
  for (let i = 0; i < bytes.length; i += 64 * 1024) yield bytes.subarray(i, i + 64 * 1024);
}

type Got = { status: number; headers: IncomingHttpHeaders; body: Buffer };

function get(url: string, headers: OutgoingHttpHeaders = {}, method: 'GET' | 'HEAD' = 'GET'): Promise<Got> {
  return new Promise((ok, fail) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

/** GETs `url` with `range`, reads the first chunk, then stops reading, so the provider's response backs up. */
function openPaused(url: string, range: string): Promise<IncomingMessage> {
  return new Promise((ok, fail) => {
    const req = httpRequest(url, { headers: { range } }, (res) => {
      res.on('error', () => {}); // cut short on purpose by the tests
      res.once('data', () => {
        res.pause();
        ok(res);
      });
    });
    req.on('error', fail);
    req.end();
  });
}

/** Resumes a paused response and resolves once it has closed: whether it arrived complete, and the bytes read. */
function endOf(res: IncomingMessage): Promise<{ complete: boolean; bytes: number }> {
  return new Promise((ok) => {
    let bytes = 0;
    const done = () => ok({ complete: res.complete, bytes });
    if (res.destroyed) return done();
    res.on('data', (c: Buffer) => {
      bytes += c.length;
    });
    res.once('close', done);
    res.resume();
  });
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`did not happen within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
