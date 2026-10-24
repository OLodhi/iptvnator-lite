import type { SyncStatus } from '@tv/shared';
import type { Db } from '../db/db.ts';
import type { ProviderService } from '../providers/service.ts';
import { silentLog } from '../util/log.ts';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';
import { syncCatalogue } from './sync.ts';

export interface SyncRunner {
  start(providerId: number): void;
  status(providerId: number): SyncStatus;
}

const IDLE: SyncStatus = { state: 'idle', startedAt: null, finishedAt: null, result: null, error: null, failures: 0 };

export function createSyncRunner(deps: {
  db: Db;
  providers: ProviderService;
  /** Called after each successful sync; a throw here is logged and does not fail the sync. */
  onSynced?: (providerId: number) => void;
  log?: Log;
}): SyncRunner {
  const log = deps.log ?? silentLog;
  const statuses = new Map<number, SyncStatus>();

  return {
    start(providerId) {
      if (statuses.get(providerId)?.state === 'running') return;
      const startedAt = Date.now();
      const failures = statuses.get(providerId)?.failures ?? 0;
      statuses.set(providerId, { state: 'running', startedAt, finishedAt: null, result: null, error: null, failures });
      void (async () => {
        try {
          try {
            await deps.providers.refreshAccount(providerId);
          } catch (err) {
            // The stored account is good enough to sync with.
            const error = redactUrl(err instanceof Error ? err.message : 'Refresh failed');
            log.warn({ providerId, err: error }, 'account refresh failed');
          }
          const client = deps.providers.clientFor(providerId);
          const result = await syncCatalogue({ db: deps.db, client, providerId, log });
          const finishedAt = Date.now();
          deps.providers.markSynced(providerId, finishedAt);
          statuses.set(providerId, { state: 'idle', startedAt, finishedAt, result, error: null, failures: 0 });
          const { live, movie, series } = result;
          log.info({ providerId, live, movie, series, durationMs: finishedAt - startedAt }, 'catalogue synced');
          try {
            deps.onSynced?.(providerId);
          } catch (err) {
            log.warn({ providerId, err: redactUrl(err instanceof Error ? err.message : String(err)) }, 'after-sync hook failed');
          }
        } catch (err) {
          // ProviderError messages never carry credential-bearing URLs (ruling R3); anything else is redacted too.
          const error = redactUrl(err instanceof Error ? err.message : 'Sync failed');
          const finishedAt = Date.now();
          statuses.set(providerId, { state: 'failed', startedAt, finishedAt, result: null, error, failures: failures + 1 });
          log.warn({ providerId, err: error, durationMs: finishedAt - startedAt }, 'catalogue sync failed');
        }
      })();
    },
    status: (providerId) => statuses.get(providerId) ?? IDLE,
  };
}
