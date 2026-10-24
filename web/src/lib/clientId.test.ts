import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const RE = /^[A-Za-z0-9_-]{1,64}$/;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

test('getClientId is stable and persisted', async () => {
  const { getClientId } = await import('./clientId.ts');
  const a = getClientId();
  expect(a).toMatch(RE);
  expect(getClientId()).toBe(a);
  expect(localStorage.getItem('tv.clientId')).toBe(a);
});

test('getClientId reuses a stored id and ignores an invalid one', async () => {
  localStorage.setItem('tv.clientId', 'abc_DEF-123');
  let m = await import('./clientId.ts');
  expect(m.getClientId()).toBe('abc_DEF-123');
  vi.resetModules();
  localStorage.setItem('tv.clientId', 'bad id!');
  m = await import('./clientId.ts');
  expect(m.getClientId()).toMatch(RE);
  expect(m.getClientId()).not.toBe('bad id!');
});

test('getClientId survives storage errors with a stable valid id', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied');
  });
  const { getClientId } = await import('./clientId.ts');
  const a = getClientId();
  expect(a).toMatch(RE);
  expect(getClientId()).toBe(a);
});
