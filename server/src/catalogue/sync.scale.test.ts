import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { createXtreamClient } from '../providers/xtream/client.ts';
import type { XtreamClient } from '../providers/xtream/client.ts';
import { startGeneratedFake } from '../testing/generatedFake.ts';
import { syncCatalogue } from './sync.ts';

let fake: Awaited<ReturnType<typeof startGeneratedFake>>;
let url: string;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-scale-'));
  fake = await startGeneratedFake('50000,200000,50000,400');
  url = fake.url;
}, 60_000);

afterAll(() => {
  fake?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('syncs 300,000 items in under 60 s and under +400 MB RSS, then resyncs 1% fewer without blocking', async () => {
  const db = openDb(path.join(tmp, 'scale.sqlite'));
  const providers = createProviderService({ db, userAgent: 'scale' });
  const { id } = await providers.add({ kind: 'xtream', serverUrl: url, username: 'u', password: 'p' });
  const client = createXtreamClient({ serverUrl: url, username: 'u', password: 'p' }, { userAgent: 'scale' });

  global.gc?.();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 250);
  const t0 = Date.now();
  try {
    await syncCatalogue({ db, client, providerId: id });
  } finally {
    clearInterval(timer);
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  const seconds = (Date.now() - t0) / 1000;
  const deltaMb = (peak - baseline) / 1024 / 1024;
  console.log(`SCALE duration=${seconds.toFixed(1)}s peakRssDelta=${deltaMb.toFixed(0)}MB`);

  expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(300_000);
  expect(seconds).toBeLessThan(60);
  expect(deltaMb).toBeLessThan(400);

  // Resync with 1% of the items gone (every 100th id; the generated ids run 1..N per kind).
  const thinned: XtreamClient = {
    ...client,
    async *streamItems(kind) {
      for await (const it of client.streamItems(kind)) {
        if (Number(it.remoteId) % 100 !== 0) yield it;
      }
    },
  };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const r0 = Date.now();
  let resync;
  try {
    resync = await syncCatalogue({ db, client: thinned, providerId: id, now: () => Date.now() + 1000 });
  } finally {
    delay.disable();
  }
  const resyncSeconds = (Date.now() - r0) / 1000;
  const maxDelayMs = delay.max / 1e6;
  console.log(`SCALE resync=${resyncSeconds.toFixed(1)}s maxEventLoopDelay=${maxDelayMs.toFixed(0)}ms`);

  expect(resync.live.removed + resync.movie.removed + resync.series.removed).toBe(3_000);
  expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(297_000);
  db.close();
  expect(resyncSeconds).toBeLessThan(60);
  expect(maxDelayMs).toBeLessThan(1000);
});
