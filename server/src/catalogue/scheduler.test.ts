import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '@tv/shared';
import type { ProviderService } from '../providers/service.ts';
import { createRefreshScheduler } from './scheduler.ts';
import type { SyncRunner } from './syncRunner.ts';

const HOUR = 3_600_000;
const NOW = 1_000_000_000_000;

function setup(lastSyncedAt: number | null, state: SyncStatus['state'] = 'idle') {
  const started: number[] = [];
  const providers = { list: () => [{ id: 7, lastSyncedAt }] } as unknown as ProviderService;
  const sync: SyncRunner = {
    start: (id) => void started.push(id),
    status: () => ({ state, startedAt: null, finishedAt: null, result: null, error: null }),
  };
  let now = NOW;
  const scheduler = createRefreshScheduler({ providers, sync, now: () => now });
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

  it('starts a sync for a provider last synced more than 24 h ago', () => {
    const { started, scheduler } = setup(NOW - 25 * HOUR);
    scheduler.tick();
    expect(started).toEqual([7]);
  });

  it('starts a sync for a provider that has never synced', () => {
    const { started, scheduler } = setup(null);
    scheduler.tick();
    expect(started).toEqual([7]);
  });

  it('does not start one synced 2 h ago', () => {
    const { started, scheduler } = setup(NOW - 2 * HOUR);
    scheduler.tick();
    expect(started).toEqual([]);
  });

  it('never starts while a sync is running', () => {
    const { started, scheduler } = setup(NOW - 48 * HOUR, 'running');
    scheduler.tick();
    expect(started).toEqual([]);
  });

  it('tick runs once at start(), then hourly', () => {
    const { started, scheduler, advance } = setup(null);
    scheduler.start();
    expect(started).toHaveLength(1);
    advance(HOUR);
    expect(started).toHaveLength(2);
    advance(HOUR);
    expect(started).toHaveLength(3);
    scheduler.stop();
  });

  it('stop clears the timer', () => {
    const { started, scheduler, advance } = setup(null);
    scheduler.start();
    scheduler.stop();
    advance(5 * HOUR);
    expect(started).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
