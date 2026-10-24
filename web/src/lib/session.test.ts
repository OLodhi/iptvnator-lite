import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { releaseSession, startHeartbeat } from './session.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const ok = (status = 204) => vi.fn(async (..._a: any[]) => new Response(null, { status }));

test('heartbeats every 15s and stops when asked', async () => {
  const f = ok();
  const stop = startHeartbeat('s1', 'c1', { fetchFn: f, onGone: vi.fn() });
  expect(f).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15000);
  expect(f).toHaveBeenCalledTimes(1);
  expect(f.mock.calls[0]![0]).toBe('/api/sessions/s1/c1/heartbeat');
  expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  await vi.advanceTimersByTimeAsync(30000);
  expect(f).toHaveBeenCalledTimes(3);
  stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f).toHaveBeenCalledTimes(3);
});

test('a 404 heartbeat calls onGone once and stops', async () => {
  const f = ok(404);
  const onGone = vi.fn();
  startHeartbeat('s1', 'c1', { fetchFn: f, onGone });
  await vi.advanceTimersByTimeAsync(15000);
  expect(onGone).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f).toHaveBeenCalledTimes(1);
  expect(onGone).toHaveBeenCalledTimes(1);
});

test('network errors and other statuses do not end the session', async () => {
  const f = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const onGone = vi.fn();
  startHeartbeat('s1', 'c1', { fetchFn: f, onGone, intervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f).toHaveBeenCalledTimes(3);
  expect(onGone).not.toHaveBeenCalled();
});

test('releaseSession sends a keepalive DELETE to the path form', async () => {
  const f = ok();
  await releaseSession('s1', 'c1', f);
  expect(f).toHaveBeenCalledWith('/api/sessions/s1/c1', { method: 'DELETE', keepalive: true });
});

test('releaseSession never throws', async () => {
  await expect(releaseSession('s1', 'c1', vi.fn().mockRejectedValue(new Error('x')))).resolves.toBeUndefined();
});
