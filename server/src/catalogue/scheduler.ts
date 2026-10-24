import type { ProviderService } from '../providers/service.ts';
import type { SyncRunner } from './syncRunner.ts';

export interface RefreshScheduler {
  start(): void;
  stop(): void;
  tick(): void;
}

export function createRefreshScheduler(deps: {
  providers: ProviderService;
  sync: SyncRunner;
  now: () => number;
  intervalMs?: number;
  checkEveryMs?: number;
}): RefreshScheduler {
  const intervalMs = deps.intervalMs ?? 86_400_000;
  const checkEveryMs = deps.checkEveryMs ?? 3_600_000;
  let timer: NodeJS.Timeout | undefined;

  function tick(): void {
    const now = deps.now();
    for (const p of deps.providers.list()) {
      if (deps.sync.status(p.id).state === 'running') continue;
      // A never-synced provider is stale.
      if (p.lastSyncedAt === null || now - p.lastSyncedAt > intervalMs) deps.sync.start(p.id);
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
