import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { get } from 'svelte/store';
import type { SearchResults } from '@tv/shared';
import { createSearchModel } from './searchModel.ts';

const results = (name: string): SearchResults => ({
  live: [{ id: 1, providerId: 1, kind: 'live', name, displayName: name, logoUrl: null, catchupDays: null, year: null, rating: null, favourite: false }],
  movie: [],
  series: [],
  categories: [],
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('debounces typing into one request', async () => {
  const search = vi.fn(async (q: string) => results(q));
  const model = createSearchModel({ search });
  model.setQuery('b');
  model.setQuery('bb');
  model.setQuery('bbc');
  await vi.advanceTimersByTimeAsync(249);
  expect(search).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(search).toHaveBeenCalledTimes(1);
  expect(search.mock.calls[0]![0]).toBe('bbc');
  expect(get(model).results?.live[0]?.name).toBe('bbc');
});

test('drops a slow earlier response that arrives after a newer one', async () => {
  const resolvers: Record<string, (r: SearchResults) => void> = {};
  const search = vi.fn((q: string) => new Promise<SearchResults>((res) => (resolvers[q] = res)));
  const model = createSearchModel({ search });
  model.setQuery('slow');
  await vi.advanceTimersByTimeAsync(250);
  model.setQuery('fast');
  await vi.advanceTimersByTimeAsync(250);
  resolvers.fast!(results('fast'));
  await vi.advanceTimersByTimeAsync(0);
  resolvers.slow!(results('slow'));
  await vi.advanceTimersByTimeAsync(0);
  expect(get(model).results?.live[0]?.name).toBe('fast');
  expect(get(model).loading).toBe(false);
});

test('aborts the superseded request', async () => {
  const signals: AbortSignal[] = [];
  const search = vi.fn((_q: string, signal?: AbortSignal) => {
    signals.push(signal!);
    return new Promise<SearchResults>(() => {});
  });
  const model = createSearchModel({ search });
  model.setQuery('one');
  await vi.advanceTimersByTimeAsync(250);
  model.setQuery('two');
  expect(signals[0]!.aborted).toBe(true);
});

test('a whitespace-only query performs no request and clears results', async () => {
  const search = vi.fn(async (q: string) => results(q));
  const model = createSearchModel({ search });
  model.setQuery('abc');
  await vi.advanceTimersByTimeAsync(250);
  model.setQuery('   ');
  await vi.advanceTimersByTimeAsync(500);
  expect(search).toHaveBeenCalledTimes(1);
  expect(get(model)).toMatchObject({ results: null, loading: false, error: null });
});

test('a failed request reports an error and retry runs it again', async () => {
  const search = vi.fn<(q: string) => Promise<SearchResults>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(results('x'));
  const model = createSearchModel({ search });
  model.setQuery('x');
  await vi.advanceTimersByTimeAsync(250);
  expect(get(model).error).toBeTruthy();
  model.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(get(model)).toMatchObject({ error: null });
  expect(get(model).results?.live).toHaveLength(1);
});
