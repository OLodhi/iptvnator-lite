import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as me from './me.ts';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function last() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
  return { url, method: init?.method ?? 'GET', body: init?.body, headers: new Headers(init?.headers) };
}

test('browse', async () => {
  await me.browse('movie');
  expect(last()).toMatchObject({ url: '/api/me/browse/movie', method: 'GET' });
});

test('pin and unpin', async () => {
  await me.pin(7);
  expect(last()).toMatchObject({ url: '/api/me/pins', method: 'POST', body: JSON.stringify({ categoryId: 7 }) });
  await me.unpin(7);
  expect(last()).toMatchObject({ url: '/api/me/pins/7', method: 'DELETE' });
});

test('favourite and unfavourite', async () => {
  await me.favourite(9);
  expect(last()).toMatchObject({ url: '/api/me/favourites', method: 'POST', body: JSON.stringify({ itemId: 9 }) });
  await me.unfavourite(9);
  expect(last()).toMatchObject({ url: '/api/me/favourites/9', method: 'DELETE' });
});

test('positions and reportPosition', async () => {
  await me.positions(5);
  expect(last()).toMatchObject({ url: '/api/me/positions/5', method: 'GET' });
  const r = { itemId: 5, positionSec: 10, durationSec: 100 };
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await me.reportPosition(r);
  expect(last()).toMatchObject({ url: '/api/me/positions', method: 'PUT', body: JSON.stringify(r) });
});

test('search encodes the query and passes the limit', async () => {
  await me.search('a b&c');
  expect(last().url).toBe('/api/search?q=a%20b%26c');
  await me.search('x', 20);
  expect(last().url).toBe('/api/search?q=x&limit=20');
  const ctl = new AbortController();
  await me.search('x', 20, ctl.signal);
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  expect(init.signal).toBe(ctl.signal);
});

test('curation and saveCuration', async () => {
  await me.curation(2, 'live');
  expect(last()).toMatchObject({ url: '/api/providers/2/curation/live', method: 'GET' });
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const u = { tags: { UK: true }, categories: { '12': false } };
  await expect(me.saveCuration(2, 'live', u)).resolves.toBeUndefined();
  expect(last()).toMatchObject({ url: '/api/providers/2/curation/live', method: 'PUT', body: JSON.stringify(u) });
});

test('hideCategory', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await me.hideCategory(4);
  expect(last()).toMatchObject({ url: '/api/categories/4/hide', method: 'POST' });
});

test('importIptvnator sends the file as application/octet-stream', async () => {
  const file = new File(['{"a":1}'], 'backup.json', { type: 'application/json' });
  await me.importIptvnator(3, file);
  const l = last();
  expect(l).toMatchObject({ url: '/api/providers/3/import/iptvnator', method: 'POST' });
  expect(l.headers.get('content-type')).toBe('application/octet-stream');
  expect(l.body).toBe(file);
});

test('refresh posts to sync', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
  await me.refresh(3);
  expect(last()).toMatchObject({ url: '/api/providers/3/sync', method: 'POST' });
});
