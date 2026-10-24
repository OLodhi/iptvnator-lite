import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '@tv/shared';
import type { ProviderService } from '../providers/service.ts';
import { backoffMs, catalogueJob, createRefreshScheduler } from './scheduler.ts';
import type { RefreshJob } from './scheduler.ts';
import type { SyncRunner } from './syncRunner.ts';

const HOUR = 3_600_000;
const NOW = 1_000_000_000_000;

function job(overrides: Partial<RefreshJob> = {}): RefreshJob & { started: number[] } {
  const started: number[] = [];
  return {
    name: 'test',
    providerIds: () => [7],
    running: () => false,
    due: () => true,
    start: (id) => void started.push(id),
    ...overrides,
    started,
  };
}

function setupCatalogue(lastSyncedAt: number | null, status: Partial<SyncStatus> = {}) {
  const started: number[] = [];
  const providers = { list: () => [{ id: 7, lastSyncedAt }], get: () => ({ id: 7, lastSyncedAt }) } as unknown as ProviderService;
  const sync: SyncRunner = {
    start: (id) => void started.push(id),
    status: () => ({ state: 'idle', startedAt: null, finishedAt: null, result: null, error: null, failures: 0, ...status }),
  };
  let now = NOW;
  const scheduler = createRefreshScheduler({ jobs: [catalogueJob({ providers, sync })], now: () => now });
  return {
    started,
    scheduler,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

describe('refresh scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs every due job per provider', () => {
    const a = job({ providerIds: () => [1, 2] });
    const b = job({ providerIds: () => [3], due: (id) => id === 3 });
    const idle = job({ due: () => false });
    const running = job({ running: () => true });
    createRefreshScheduler({ jobs: [a, b, idle, running], now: () => NOW }).tick();
    expect(a.started).toEqual([1, 2]);
    expect(b.started).toEqual([3]);
    expect(idle.started).toEqual([]);
    expect(running.started).toEqual([]);
  });

  it('backoff doubles from one hour to a day', () => {
    expect([0, 1, 2, 3, 6, 10].map(backoffMs)).toEqual([0, HOUR, 2 * HOUR, 4 * HOUR, 24 * HOUR, 24 * HOUR]);
  });

  it("a job that throws doesn't stop the tick", () => {
    const warnings: string[] = [];
    const broken = job({ providerIds: () => { throw new Error('boom http://h/x?username=u&password=secret'); } });
    const flaky = job({
      providerIds: () => [1, 2],
      due: (id) => {
        if (id === 1) throw new Error('bad provider');
        return true;
      },
    });
    const good = job();
    createRefreshScheduler({
      jobs: [broken, flaky, good],
      now: () => NOW,
      log: { info() {}, warn: (o) => void warnings.push(JSON.stringify(o)) },
    }).tick();
    expect(flaky.started).toEqual([2]);
    expect(good.started).toEqual([7]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join()).not.toContain('secret');
  });

  it('a failing provider waits for its backoff', () => {
    // Synced long ago, then failed twice: wait 2 h from the last attempt.
    const { started, scheduler, advance } = setupCatalogue(NOW - 48 * HOUR, { state: 'failed', finishedAt: NOW, failures: 2 });
    scheduler.tick();
    expect(started).toEqual([]);
    advance(2 * HOUR - 1);
    scheduler.tick();
    expect(started).toEqual([]);
    advance(1);
    scheduler.tick();
    expect(started).toEqual([7]);
  });

  it('starts a sync for a provider last synced more than 24 h ago, or never', () => {
    const stale = setupCatalogue(NOW - 25 * HOUR);
    stale.scheduler.tick();
    expect(stale.started).toEqual([7]);
    const never = setupCatalogue(null);
    never.scheduler.tick();
    expect(never.started).toEqual([7]);
  });

  it('does not start one synced 2 h ago, or one that is running', () => {
    const fresh = setupCatalogue(NOW - 2 * HOUR);
    fresh.scheduler.tick();
    expect(fresh.started).toEqual([]);
    const busy = setupCatalogue(NOW - 48 * HOUR, { state: 'running' });
    busy.scheduler.tick();
    expect(busy.started).toEqual([]);
  });

  it('tick runs once at start(), then hourly', () => {
    const { started, scheduler, advance } = setupCatalogue(null);
    scheduler.start();
    expect(started).toHaveLength(1);
    advance(HOUR);
    expect(started).toHaveLength(2);
    scheduler.stop();
  });

  it('stop clears the timer', () => {
    const { started, scheduler, advance } = setupCatalogue(null);
    scheduler.start();
    scheduler.stop();
    advance(5 * HOUR);
    expect(started).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
