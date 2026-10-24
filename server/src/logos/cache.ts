import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CachedLogo {
  path: string;
  contentType: string;
}

export interface LogoCache {
  /** The cached image for `url` (fetched if missing or older than the TTL), or null if it is not a usable image. */
  get(url: string): Promise<CachedLogo | null>;
}

const DAY_MS = 86_400_000;

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
  timeoutMs?: number;
}): LogoCache {
  const { dir, now, userAgent } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const ttlMs = deps.ttlMs ?? 7 * DAY_MS;
  const maxBytes = deps.maxBytes ?? 2_000_000;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const inFlight = new Map<string, Promise<CachedLogo | null>>();

  async function cached(key: string): Promise<CachedLogo | null> {
    for (const [ext, contentType] of Object.entries(CONTENT_TYPES)) {
      const file = path.join(dir, `${key}.${ext}`);
      try {
        const stat = await fs.stat(file);
        if (now() - stat.mtimeMs < ttlMs) return { path: file, contentType };
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

  async function fetchAndStore(url: string, key: string): Promise<CachedLogo | null> {
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
      if (!body) return null;
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${key}.${ext}`);
      const tmp = `${file}.${process.pid}.${now()}.tmp`;
      await fs.writeFile(tmp, body);
      const stamp = new Date(now());
      await fs.utimes(tmp, stamp, stamp);
      await fs.rename(tmp, file);
      return { path: file, contentType: CONTENT_TYPES[ext]! };
    } catch {
      return null;
    }
  }

  return {
    async get(url) {
      if (!/^https?:\/\//i.test(url)) return null;
      const key = createHash('sha256').update(url).digest('hex');
      const pending = inFlight.get(key);
      if (pending) return pending;
      const job = (async () => (await cached(key)) ?? (await fetchAndStore(url, key)))().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job;
    },
  };
}
