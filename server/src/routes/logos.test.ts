import { afterAll, beforeAll, expect, test } from 'vitest';
import type { CatalogItem, SearchResults } from '@tv/shared';
import { startBrowseApp } from '../testing/browseApp.ts';
import { browseCatalogue } from '../testing/browseCatalogue.ts';
import { PNG, startImageServer } from '../testing/imageServer.ts';

let h: Awaited<ReturnType<typeof startBrowseApp>>;
let images: Awaited<ReturnType<typeof startImageServer>>;
let withLogo: number;
let withoutLogo: number;
let brokenLogo: number;

beforeAll(async () => {
  images = await startImageServer();
  h = await startBrowseApp(browseCatalogue());
  const [a, b, c] = (h.db.prepare("SELECT id FROM items WHERE kind = 'live' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  withLogo = a!;
  brokenLogo = b!;
  withoutLogo = c!;
  h.db.prepare('UPDATE items SET logo_url = ? WHERE id = ?').run(`${images.url}/logo.png`, withLogo);
  h.db.prepare('UPDATE items SET logo_url = ? WHERE id = ?').run(`${images.url}/page.html`, brokenLogo);
  h.db.prepare('UPDATE items SET logo_url = NULL WHERE id = ?').run(withoutLogo);
});
afterAll(async () => {
  await h.close();
  await images.close();
});

test('the route serves the cached file with cache headers', async () => {
  const res = await h.app.inject(`/api/logos/${withLogo}`);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('image/png');
  expect(res.headers['cache-control']).toBe('public, max-age=604800');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.rawPayload).toEqual(PNG);
  await h.app.inject(`/api/logos/${withLogo}`);
  expect(images.hits.filter((x) => x.url === '/logo.png')).toHaveLength(1);
});

test('404 when the item has no logo, the fetch fails, or the item is unknown; browsers may keep that for an hour', async () => {
  for (const id of [withoutLogo, brokenLogo, 999999]) {
    const res = await h.app.inject(`/api/logos/${id}`);
    expect(res.statusCode, String(id)).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(res.headers['cache-control'], String(id)).toBe('public, max-age=3600');
  }
  expect((await h.app.inject('/api/logos/abc')).statusCode).toBe(400);
  // The failed fetch is remembered: asking again within the hour answers 404 without going to the provider.
  expect((await h.app.inject(`/api/logos/${brokenLogo}`)).statusCode).toBe(404);
  expect(images.hits.filter((x) => x.url === '/page.html')).toHaveLength(1);
});

test('item responses never contain provider logo URLs', async () => {
  const browse = await h.app.inject('/api/me/browse/live');
  const search = (await h.app.inject('/api/search?q=sky')).json() as SearchResults;
  const body = browse.body + JSON.stringify(search);
  expect(body).not.toContain('http');
  expect(body).not.toContain(images.url);
  const sky = search.live.find((i: CatalogItem) => i.id === withLogo);
  expect(sky?.logoUrl).toBe(`/api/logos/${withLogo}`);
  const bare = (await h.app.inject('/api/search?q=espn')).json() as SearchResults;
  expect(bare.live[0]?.logoUrl).toBeNull();
});
