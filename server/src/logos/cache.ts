import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CachedLogo {
  path: string;
  contentType: string;
}

export interface LogoCache {
  /**
   * The cached image for `url` (fetched if missing or older than the TTL), or null if it is not a usable image. A
   * fetch that failed is remembered for an hour, and null comes back at once until then.
   */
  get(url: string): Promise<CachedLogo | null>;
  /** Deletes leftovers (.tmp), files older than twice the TTL, then the oldest files while the total is over the cap. */
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
}): LogoCache {
  const { dir, now, userAgent } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const ttlMs = deps.ttlMs ?? 7 * DAY_MS;
  const maxBytes = deps.maxBytes ?? 2_000_000;
  const maxCacheBytes = deps.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxFailures = deps.maxFailures ?? MAX_FAILURES;
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
      const res = await fetchFn(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: userAgent ? { 'user-agent': userAgent } : {},
      });
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
      if ((name.endsWith('.tmp') || now() - stat.mtimeMs > 2 * ttlMs) && (await remove(file, stat.size))) continue;
      kept.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    let total = kept.reduce((sum, f) => sum + f.size, 0);
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of kept) {
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
      const job = (async () => (await cached(key)) ?? (await fetchAndStore(url, key)))().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job;
    },
  };
}
