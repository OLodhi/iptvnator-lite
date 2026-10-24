import { spawn as nodeSpawn } from 'node:child_process';
import type { Db } from '../db/db.ts';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';

export type ProbeResult = {
  formatName: string;
  durationSec: number | null;
  video: {
    codec: string;
    codecTag: string | null;
    width: number;
    height: number;
    interlaced: boolean;
    /** ffprobe's raw `field_order` ('progressive', 'tt', ...), for the logs. */
    fieldOrder: string | null;
  } | null;
  audio: { index: number; codec: string; channels: number }[];
};

/** A probe's result, and whether it came from the probe cache rather than a fresh ffprobe run. */
export type ProbeOutcome = { result: ProbeResult; cached: boolean };

/** `skipCache`: the cache is neither read nor written, for a URL that is good for one request only (a timeshift). */
export type ProbeOptions = { skipCache?: boolean };

export interface Prober {
  /**
   * Probes the stream at `url`. `readFrom`, when given, is where ffprobe actually reads it (a session's relay URL);
   * the result is still cached, logged and forgotten by `url`, as a relay URL lasts only as long as its session.
   */
  probe(url: string, userAgent: string, readFrom?: string, opts?: ProbeOptions): Promise<ProbeOutcome>;
  /** Forgets any cached result for `url`, so its next probe runs ffprobe again (R34). */
  invalidate(url: string): void;
}

const CACHE_TTL_MS = 24 * 3600_000;
const INTERLACED = new Set(['tt', 'bb', 'tb', 'bt']);

type RawStream = {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  field_order?: string;
  channels?: number;
};

export function parseFfprobe(json: unknown): ProbeResult {
  const root = (json ?? {}) as { streams?: RawStream[]; format?: { format_name?: string; duration?: string | number } };
  const streams = root.streams ?? [];

  const v = streams.find((s) => s.codec_type === 'video');
  const tag = v?.codec_tag_string;
  // ffprobe prints unknown tags as "[0][0][0][0]"; treat those as no tag.
  const codecTag = tag && !tag.startsWith('[') ? tag : null;

  const duration = Number(root.format?.duration);
  return {
    formatName: root.format?.format_name ?? '',
    durationSec: root.format?.duration !== undefined && Number.isFinite(duration) ? duration : null,
    video: v
      ? {
          codec: v.codec_name ?? 'unknown',
          codecTag,
          width: v.width ?? 0,
          height: v.height ?? 0,
          interlaced: INTERLACED.has(v.field_order ?? ''),
          fieldOrder: v.field_order ?? null,
        }
      : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({ index: s.index ?? 0, codec: s.codec_name ?? 'unknown', channels: s.channels ?? 0 })),
  };
}

/** Wraps a probe so each result is logged as one line: container, video, audio, duration and whether it was cached (URL redacted). */
export function withProbeLog(probe: Prober['probe'], log: Log): Prober['probe'] {
  return async (url, userAgent, readFrom, opts) => {
    const outcome = await probe(url, userAgent, readFrom, opts);
    const { result: r, cached } = outcome;
    const v = r.video;
    log.info(
      {
        url: redactUrl(url),
        container: r.formatName,
        // Results cached before fieldOrder existed have none.
        video: v ? `${v.codec} ${v.width}x${v.height} ${v.fieldOrder ?? 'unknown'}` : 'none',
        audio: r.audio.map((a) => a.codec).join(',') || 'none',
        durationSec: r.durationSec,
        cached,
      },
      'probed',
    );
    return outcome;
  };
}

/** Enough of a ProbeResult's shape that a cached row can be used without throwing later. */
function isProbeResult(v: unknown): v is ProbeResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<ProbeResult>;
  return typeof r.formatName === 'string' && Array.isArray(r.audio) && (r.video === null || typeof r.video === 'object');
}

export function createProber(deps: {
  ffprobePath: string;
  db: Db;
  now?: () => number;
  timeoutMs?: number;
  spawnFn?: typeof nodeSpawn;
}): Prober {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const getStmt = deps.db.prepare('SELECT result, probed_at FROM probe_cache WHERE url_key = ?');
  const putStmt = deps.db.prepare(
    'INSERT INTO probe_cache (url_key, result, probed_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(url_key) DO UPDATE SET result = excluded.result, probed_at = excluded.probed_at',
  );
  const deleteStmt = deps.db.prepare('DELETE FROM probe_cache WHERE url_key = ?');

  /** A fresh, readable cached result; a row that is stale or doesn't parse is a miss (and is overwritten). */
  function fromCache(key: string): ProbeResult | null {
    const row = getStmt.get(key) as { result: string; probed_at: number } | undefined;
    if (!row || now() - row.probed_at >= CACHE_TTL_MS) return null;
    try {
      const parsed: unknown = JSON.parse(row.result);
      return isProbeResult(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // Error messages deliberately never include the URL or ffprobe's stderr (credentials live in the URL).
  function runFfprobe(url: string, userAgent: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        '-probesize', '1000000',
        '-analyzeduration', '1500000',
        '-user_agent', userAgent,
        url,
      ];
      const child = spawnFn(deps.ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`ffprobe timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      child.stdout!.on('data', (c: Buffer) => chunks.push(c));
      child.on('error', () => finish(() => reject(new Error('ffprobe could not be started'))));
      child.on('close', (code) =>
        finish(() => {
          if (code !== 0) return reject(new Error(`ffprobe failed with exit code ${code}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('ffprobe produced unparseable output'));
          }
        }),
      );
    });
  }

  // Rows are keyed by the redacted URL, so no credentials are stored.
  return {
    async probe(url, userAgent, readFrom, opts) {
      const key = redactUrl(url);
      const cached = opts?.skipCache ? null : fromCache(key);
      if (cached) return { result: cached, cached: true };

      const result = parseFfprobe(await runFfprobe(readFrom ?? url, userAgent));
      if (!opts?.skipCache) putStmt.run(key, JSON.stringify(result), now());
      return { result, cached: false };
    },
    invalidate(url) {
      deleteStmt.run(redactUrl(url));
    },
  };
}
