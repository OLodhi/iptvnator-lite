import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkPublicUrl } from '../net/publicAddress.ts';

export interface CachedLogo {
  path: string;
  contentType: string;
}

/** Thrown by `get` when every fetch slot is busy and the waiting queue is full; nothing was fetched. */
export class LogoBusyError extends Error {
  constructor() {
    super('Too many logo fetches in progress');
  }
}

export interface LogoCache {
  /**
   * The cached image for `url` (fetched if missing or older than the TTL), or null if it is not a usable image. A
   * fetch that failed is remembered for an hour, and null comes back at once until then. Only a fetch waits for a
   * slot; rejects with LogoBusyError when the queue is full.
   */
  get(url: string): Promise<CachedLogo | null>;
  /** Deletes leftovers (.tmp, once ten minutes old), files older than twice the TTL, then the oldest files while the total is over the cap. */
  sweep(): Promise<{ deleted: number; bytes: number }>;
  /** Sweeps now and then daily, on a timer that does not keep the process alive. */
  start(): void;
  stop(): void;
}

export const DEFAULT_MAX_CACHE_BYTES = 500_000_000;
const SWEEP_INTERVAL_MS = 86_400_000;

const DAY_MS = 86_400_000;
const FAILURE_TTL_MS = 3_600_000;
const MAX_FAILURES = 5_000;
export const MAX_CONCURRENT_FETCHES = 8;
export const MAX_QUEUED_FETCHES = 200;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** A temp file this young may still be mid-write. */
const TMP_MIN_AGE_MS = 600_000;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

export function createLogoCache(deps: {
  dir: string;
  fetchFn?: typeof fetch;
  now: () => number;
  userAgent?: string;
  ttlMs?: number;
  maxBytes?: number;
  maxCacheBytes?: number;
  timeoutMs?: number;
  /** How many failed URLs are remembered; past it, the oldest is forgotten. */
  maxFailures?: number;
  /** Outbound fetches at once (this cache's, shared by all requests) and how many more may wait for a slot. */
  maxConcurrent?: number;
  maxQueued?: number;
  /** Fetch from loopback, private and link-local addresses too (for a provider on the LAN); refused if left out. */
  allowPrivate?: boolean;
  /** Resolves host names for the address check; the system resolver if left out. */
  lookup?: Parameters<typeof checkPublicUrl>[1];
}): LogoCache {
  const { dir, now, userAgent, lookup } = deps;
  const allowPrivate = deps.allowPrivate ?? false;
  const fetchFn = deps.fetchFn ?? fetch;
  const ttlMs = deps.ttlMs ?? 7 * DAY_MS;
  const maxBytes = deps.maxBytes ?? 2_000_000;
  const maxCacheBytes = deps.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxFailures = deps.maxFailures ?? MAX_FAILURES;
  const maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT_FETCHES;
  const maxQueued = deps.maxQueued ?? MAX_QUEUED_FETCHES;
  let active = 0;
  const waiting: (() => void)[] = [];
  const inFlight = new Map<string, Promise<CachedLogo | null>>();
  const failedAt = new Map<string, number>(); // url -> when its fetch failed, oldest first

  function recentlyFailed(url: string): boolean {
    const at = failedAt.get(url);
    if (at === undefined) return false;
    if (now() - at < FAILURE_TTL_MS) return true;
    failedAt.delete(url);
    return false;
  }

  function rememberFailure(url: string): void {
    failedAt.delete(url); // so it goes back in as the newest
    failedAt.set(url, now());
    if (failedAt.size > maxFailures) failedAt.delete(failedAt.keys().next().value!);
  }

  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return;
    }
    if (waiting.length >= maxQueued) throw new LogoBusyError();
    await new Promise<void>((resolve) => waiting.push(resolve)); // the releaser hands its slot over
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  /** A fetch always ends (the timeout bounds it), so a slot is never held for long. */
  async function fetchLimited(url: string, key: string): Promise<CachedLogo | null> {
    await acquire();
    try {
      return await fetchAndStore(url, key);
    } finally {
      release();
    }
  }

  async function cached(key: string): Promise<CachedLogo | null> {
    for (const [ext, contentType] of Object.entries(CONTENT_TYPES)) {
      const file = path.join(dir, `${key}.${ext}`);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && now() - stat.mtimeMs < ttlMs) return { path: file, contentType };
      } catch {
        // not cached under this extension
      }
    }
    return null;
  }

  /** Reads the body, giving up as soon as it passes `maxBytes`. */
  async function readLimited(res: Response): Promise<Buffer | null> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      return null;
    }
    if (!res.body) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /** The image at `url`, or null if the provider has no usable one (a failure, not an image, too big or too slow). */
  async function download(url: string): Promise<{ body: Buffer; ext: string } | null> {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Response;
      for (let hop = 0; ; hop++) {
        if (!allowPrivate && !(await checkPublicUrl(url, lookup))) return null;
        res = await fetchFn(url, {
          signal,
          redirect: 'manual',
          headers: userAgent ? { 'user-agent': userAgent } : {},
        });
        const location = res.headers.get('location');
        if (!REDIRECT_STATUSES.has(res.status) || !location) break;
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) return null;
        url = new URL(location, url).href;
      }
      const ext = res.ok ? EXTENSIONS[(res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()] : undefined;
      if (!ext) {
        await res.body?.cancel();
        return null;
      }
      const body = await readLimited(res);
      return body ? { body, ext } : null;
    } catch {
      return null;
    }
  }

  async function fetchAndStore(url: string, key: string): Promise<CachedLogo | null> {
    const image = await download(url);
    if (!image) {
      rememberFailure(url);
      return null;
    }
    const { body, ext } = image;
    try {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${key}.${ext}`);
      const tmp = `${file}.${process.pid}.${now()}.tmp`;
      try {
        await fs.writeFile(tmp, body);
        const stamp = new Date(now());
        await fs.utimes(tmp, stamp, stamp);
        await fs.rename(tmp, file);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      return { path: file, contentType: CONTENT_TYPES[ext]! };
    } catch {
      return null;
    }
  }

  async function sweep(): Promise<{ deleted: number; bytes: number }> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return { deleted: 0, bytes: 0 };
    }
    let deleted = 0;
    let bytes = 0;
    const remove = async (file: string, size: number): Promise<boolean> => {
      try {
        await fs.rm(file, { force: true });
        deleted++;
        bytes += size;
        return true;
      } catch {
        return false;
      }
    };
    const kept: { file: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const age = now() - stat.mtimeMs;
      const expired = name.endsWith('.tmp') ? age > TMP_MIN_AGE_MS : age > 2 * ttlMs;
      if (expired && (await remove(file, stat.size))) continue;
      kept.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    // Young temp files may be mid-write: they neither count towards the cap nor get evicted.
    const logos = kept.filter((f) => !f.file.endsWith('.tmp'));
    let total = logos.reduce((sum, f) => sum + f.size, 0);
    logos.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of logos) {
      if (total <= maxCacheBytes) break;
      if (await remove(f.file, f.size)) total -= f.size;
    }
    return { deleted, bytes };
  }

  let timer: NodeJS.Timeout | undefined;

  return {
    sweep,
    start() {
      if (timer) return;
      const run = () => void sweep().catch(() => undefined);
      run();
      timer = setInterval(run, SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    async get(url) {
      if (!/^https?:\/\//i.test(url) || recentlyFailed(url)) return null;
      const key = createHash('sha256').update(url).digest('hex');
      const pending = inFlight.get(key);
      if (pending) return pending;
      const job = (async () => (await cached(key)) ?? (await fetchLimited(url, key)))().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job;
    },
  };
}
