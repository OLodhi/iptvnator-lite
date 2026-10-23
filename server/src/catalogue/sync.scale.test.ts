import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { createXtreamClient } from '../providers/xtream/client.ts';
import { syncCatalogue } from './sync.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeScript = path.resolve(here, '../../../tools/fake-xtream/src/server.ts');
const mediaDir = path.resolve(here, '../../../tools/fake-xtream/media');

let child: ChildProcess;
let url: string;
let tmp: string;

// The fake runs in its own process so its catalogue and JSON serialisation stay out of our RSS.
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-scale-'));
  child = spawn(
    process.execPath,
    [fakeScript, '--port', '0', '--media', mediaDir, '--generate', '50000,200000,50000,400'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /listening on (http:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]!);
    });
    child.once('exit', (code) => reject(new Error(`fake exited early (${code})`)));
  });
}, 60_000);

afterAll(() => {
  child?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('syncs 300,000 items in under 60 s and under +400 MB RSS', async () => {
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
  db.close();
  expect(seconds).toBeLessThan(60);
  expect(deltaMb).toBeLessThan(400);
});
