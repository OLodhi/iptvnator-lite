import type { GuideRunner } from '../guide/runner.ts';
import type { GuideStore } from '../guide/store.ts';
import type { ProviderService } from '../providers/service.ts';
import { silentLog } from '../util/log.ts';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';
import type { SyncRunner } from './syncRunner.ts';

export interface RefreshScheduler {
  start(): void;
  stop(): void;
  tick(): void;
}

/** One kind of background refresh the scheduler checks for every provider. */
export type RefreshJob = {
  name: string;
  providerIds: () => number[];
  running(providerId: number): boolean;
  due(providerId: number, now: number): boolean;
  start(providerId: number): void;
};

const HOUR = 3_600_000;
const STALE_MS = 24 * HOUR;

/** How long to wait after this many failures in a row: none for 0, then 1 h, 2 h, 4 h … at most 24 h. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(HOUR * 2 ** (failures - 1), STALE_MS);
}

export function createRefreshScheduler(deps: {
  jobs: RefreshJob[];
  now: () => number;
  checkEveryMs?: number;
  log?: Log;
}): RefreshScheduler {
  const checkEveryMs = deps.checkEveryMs ?? HOUR;
  const log = deps.log ?? silentLog;
  let timer: NodeJS.Timeout | undefined;

  const describe = (err: unknown): string => redactUrl(err instanceof Error ? err.message : String(err));

  function tick(): void {
    const now = deps.now();
    for (const job of deps.jobs) {
      try {
        for (const providerId of job.providerIds()) {
          try {
            if (!job.running(providerId) && job.due(providerId, now)) job.start(providerId);
          } catch (err) {
            log.warn({ job: job.name, providerId, err: describe(err) }, 'refresh check failed');
          }
        }
      } catch (err) {
        log.warn({ job: job.name, err: describe(err) }, 'refresh job failed');
      }
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, checkEveryMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Sync a provider never synced or last synced over a day ago; after failures, wait out the backoff. */
export function catalogueJob(deps: { providers: ProviderService; sync: SyncRunner }): RefreshJob {
  return {
    name: 'catalogue',
    providerIds: () => deps.providers.list().map((p) => p.id),
    running: (id) => deps.sync.status(id).state === 'running',
    due(id, now) {
      const status = deps.sync.status(id);
      if (status.failures > 0 && status.finishedAt !== null) return now - status.finishedAt >= backoffMs(status.failures);
      const last = deps.providers.get(id)?.lastSyncedAt ?? null;
      return last === null || now - last > STALE_MS;
    },
    start: (id) => deps.sync.start(id),
  };
}

/** Refresh the guide of a provider that has synced and whose guide is missing or over a day old. */
export function guideJob(deps: { providers: ProviderService; guide: GuideRunner; store: GuideStore }): RefreshJob {
  return {
    name: 'guide',
    providerIds: () => deps.providers.list().map((p) => p.id),
    running: (id) => deps.guide.running(id),
    due(id, now) {
      if (deps.providers.get(id)?.lastSyncedAt == null) return false;
      const state = deps.store.state(id);
      // The store keeps seconds.
      if (state && state.failures > 0 && state.attemptedAt !== null) {
        return now - state.attemptedAt * 1000 >= backoffMs(state.failures);
      }
      return state?.fetchedAt == null || now - state.fetchedAt * 1000 > STALE_MS;
    },
    start: (id) => deps.guide.start(id),
  };
}
