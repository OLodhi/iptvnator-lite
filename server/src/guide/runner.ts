import type { GuideStatus } from '@tv/shared';
import type { Db } from '../db/db.ts';
import type { ProviderService } from '../providers/service.ts';
import { silentLog } from '../util/log.ts';
import type { Log } from '../util/log.ts';
import { redactUrl } from '../util/redact.ts';
import { refreshGuide } from './ingest.ts';
import { relinkGuideInSteps } from './match.ts';
import type { GuideStore } from './store.ts';

const errorText = (err: unknown): string => redactUrl(err instanceof Error ? err.message : String(err));

export interface GuideRunner {
  /**
   * Starts a refresh in the background. While one is already running for this provider, one more is queued to follow
   * it (at most one), because the running refresh may have fixed its wanted channels before this call.
   */
  start(providerId: number): void;
  status(providerId: number): GuideStatus;
  /** Re-matches channels to guide channels from the stored guide, without fetching, in steps that yield. */
  relink(providerId: number): Promise<void>;
  running(providerId: number): boolean;
  /** Aborts every running refresh and waits for them to settle. The abort is not recorded as a failure. */
  stop(): Promise<void>;
}

export function createGuideRunner(deps: {
  db: Db;
  store: GuideStore;
  providers: ProviderService;
  visibleLiveItemIds: (providerId: number) => number[];
  /** Milliseconds. */
  now?: () => number;
  log?: Log;
}): GuideRunner {
  const log = deps.log ?? silentLog;
  const now = deps.now ?? Date.now;
  const active = new Map<number, { controller: AbortController; done: Promise<void> }>();
  const again = new Set<number>();
  let stopped = false;

  const count = deps.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM guide_channels WHERE provider_id = @p AND generation = @g) AS channels,
       (SELECT COUNT(*) FROM programmes WHERE provider_id = @p AND generation = @g) AS programmes,
       (SELECT COUNT(*) FROM guide_links WHERE provider_id = @p) AS linkedChannels`,
  );


  async function run(providerId: number, signal: AbortSignal): Promise<void> {
    const startedAt = now();
    const failuresBefore = deps.store.state(providerId)?.failures ?? 0;
    try {
      await refreshGuide({
        db: deps.db,
        store: deps.store,
        client: deps.providers.clientFor(providerId),
        providerId,
        timezone: deps.providers.account(providerId)?.timezone ?? null,
        visibleLiveItemIds: () => deps.visibleLiveItemIds(providerId),
        now,
        log,
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        log.info({ providerId }, 'guide refresh aborted');
        return;
      }
      const error = errorText(err);
      // refreshGuide records its own failures; one thrown before that (no client, no generation) is recorded here,
      // which also anchors the scheduler's backoff.
      if ((deps.store.state(providerId)?.failures ?? 0) === failuresBefore) {
        deps.store.recordFailure(providerId, error, Math.floor(now() / 1000));
      }
      // refreshGuide rethrows the original error, which may name a URL.
      log.warn({ providerId, err: error, durationMs: now() - startedAt }, 'guide refresh failed');
    }
  }

  function begin(providerId: number): void {
    const controller = new AbortController();
    const done = run(providerId, controller.signal).finally(() => {
      active.delete(providerId);
      // Success or failure, but never after stop(): then nothing is queued.
      if (again.delete(providerId) && !stopped) begin(providerId);
    });
    active.set(providerId, { controller, done });
  }

  return {
    start(providerId) {
      if (stopped) return;
      if (active.has(providerId)) {
        again.add(providerId);
        return;
      }
      begin(providerId);
    },
    running: (providerId) => active.has(providerId),
    async relink(providerId) {
      await relinkGuideInSteps(deps.db, providerId, Math.floor(now() / 1000));
    },
    status(providerId) {
      const state = deps.store.state(providerId);
      const counts = count.get({ p: providerId, g: deps.store.currentGeneration(providerId) }) as {
        channels: number;
        programmes: number;
        linkedChannels: number;
      };
      return {
        state: active.has(providerId) ? 'running' : (state?.failures ?? 0) > 0 ? 'failed' : 'idle',
        // The store keeps seconds; the API speaks milliseconds, like lastSyncedAt.
        fetchedAt: state?.fetchedAt == null ? null : state.fetchedAt * 1000,
        source: state?.source ?? null,
        ...counts,
        error: state?.lastError ?? null,
      };
    },
    async stop() {
      stopped = true;
      again.clear();
      const pending = [...active.values()];
      for (const a of pending) a.controller.abort();
      await Promise.allSettled(pending.map((a) => a.done));
    },
  };
}

/**
 * What a catalogue sync calls when it finishes: re-match from the stored guide, in steps so a large catalogue never
 * blocks the event loop, then fetch a guide if there is none and none is being fetched. It runs in the background;
 * a failure is logged.
 */
export function afterSync(guide: GuideRunner, store: GuideStore, log: Log = silentLog): (providerId: number) => void {
  return (providerId) => {
    const run = async () => {
      try {
        await guide.relink(providerId);
      } finally {
        // start() would queue a second full refresh behind the first one.
        if (store.state(providerId)?.fetchedAt == null && !guide.running(providerId)) guide.start(providerId);
      }
    };
    run().catch((err: unknown) => log.warn({ providerId, error: errorText(err) }, 'guide relink after sync failed'));
  };
}
