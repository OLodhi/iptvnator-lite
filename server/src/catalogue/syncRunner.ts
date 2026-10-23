import type { SyncStatus } from '@tv/shared';
import type { Db } from '../db/db.ts';
import type { ProviderService } from '../providers/service.ts';
import { syncCatalogue } from './sync.ts';

export interface SyncRunner {
  start(providerId: number): void;
  status(providerId: number): SyncStatus;
}

const IDLE: SyncStatus = { state: 'idle', startedAt: null, finishedAt: null, result: null, error: null };

export function createSyncRunner(deps: { db: Db; providers: ProviderService }): SyncRunner {
  const statuses = new Map<number, SyncStatus>();

  return {
    start(providerId) {
      if (statuses.get(providerId)?.state === 'running') return;
      const startedAt = Date.now();
      statuses.set(providerId, { state: 'running', startedAt, finishedAt: null, result: null, error: null });
      void (async () => {
        try {
          const client = deps.providers.clientFor(providerId);
          const result = await syncCatalogue({ db: deps.db, client, providerId });
          const finishedAt = Date.now();
          deps.providers.markSynced(providerId, finishedAt);
          statuses.set(providerId, { state: 'idle', startedAt, finishedAt, result, error: null });
        } catch (err) {
          // ProviderError messages never carry credential-bearing URLs (ruling R3).
          const error = err instanceof Error ? err.message : 'Sync failed';
          statuses.set(providerId, { state: 'failed', startedAt, finishedAt: Date.now(), result: null, error });
        }
      })();
    },
    status: (providerId) => statuses.get(providerId) ?? IDLE,
  };
}
