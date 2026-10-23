import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { generateCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { openDb } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import { createXtreamClient } from '../providers/xtream/client.ts';
import { syncCatalogue } from './sync.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');

test('syncs 300,000 items in under 60 s and under +400 MB RSS', async () => {
  const catalogue = generateCatalogue({ live: 50_000, movie: 200_000, series: 50_000, categoriesPerKind: 400 });
  const fake = await startFakeXtream({ mediaDir, catalogue });
  try {
    const db = openDb(':memory:');
    const providers = createProviderService({ db, userAgent: 'scale' });
    const { id } = await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' });
    const client = createXtreamClient({ serverUrl: fake.url, username: 'u', password: 'p' }, { userAgent: 'scale' });

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
  } finally {
    await fake.close();
  }
});
