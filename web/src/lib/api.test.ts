import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiClientError } from './api.ts';

afterEach(() => vi.unstubAllGlobals());

test('api maps error JSON to ApiClientError', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ code: 'PROVIDER_AUTH_FAILED', message: 'nope', details: { a: 1 } }), { status: 422 })),
  );
  const err = await api('/api/providers', { method: 'POST' }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiClientError);
  expect(err).toMatchObject({ status: 422, code: 'PROVIDER_AUTH_FAILED', message: 'nope', details: { a: 1 } });
});

test('api returns parsed JSON and undefined for 204', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([1]), { status: 200 })));
  expect(await api('/x')).toEqual([1]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  expect(await api('/x')).toBeUndefined();
});

test('api copes with a non-JSON error body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad</html>', { status: 502 })));
  await expect(api('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
});

test('api sends JSON content-type when a body is given', async () => {
  const f = vi.fn(async (..._a: any[]) => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', f);
  await api('/x', { method: 'POST', body: '{}' });
  const init = f.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).get('content-type')).toBe('application/json');
});

test('api returns undefined for an empty 2xx body such as 202', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
  expect(await api('/x', { method: 'POST' })).toBeUndefined();
});
