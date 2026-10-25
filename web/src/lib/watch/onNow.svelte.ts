import type { CatalogItem, NowProgramme } from '@tv/shared';
import { api } from '../api.ts';

// An answer whose programme has already ended by this device's clock (one ahead of the server's) is retried after this.
const RETRY_MS = 30_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // a longer setTimeout fires at once

export type OnNow = {
  /** The item being watched, once fetched; null while loading or when the fetch failed. */
  readonly item: CatalogItem | null;
  /** A live item's programme on now. Hidden once its stop time has been seen to pass, until a fresh answer arrives. */
  readonly onNow: NowProgramme | null;
  /**
   * Fetches the item, unless it is the one already loaded or loading. Resolves with it once known: null when the
   * fetch fails or another item is loaded first.
   */
  load(itemId: number): Promise<CatalogItem | null>;
  /** Hides an ended programme at once and fetches what is on now. */
  refetch(): Promise<void>;
  destroy(): void;
};

/** The item being watched and what it has on now: fetched per item, again when its programme ends, and on coming back to the app. */
export function createOnNow(): OnNow {
  let item = $state<CatalogItem | null>(null);
  let checkedAt = $state(Date.now()); // when the On now programme was last held against the clock
  let itemId: number | null = null;
  let itemSeq = 0; // bumped on every item fetch and item change, so only the latest answer lands
  let itemTimer: ReturnType<typeof setTimeout> | undefined;
  let known: Promise<CatalogItem | null> = Promise.resolve(null);
  let settle: ((it: CatalogItem | null) => void) | undefined;

  function settled(it: CatalogItem | null) {
    settle?.(it);
    settle = undefined;
  }

  /** Fetches the item and schedules the next fetch for when its programme ends. */
  function fetchItem(id: number): Promise<void> {
    const mine = ++itemSeq;
    return api<CatalogItem>(`/api/items/${id}`).then(
      (it) => {
        if (mine !== itemSeq) return;
        clearTimeout(itemTimer);
        item = it ?? null;
        checkedAt = Date.now();
        settled(item);
        const stopSec = item?.now?.stopSec;
        if (stopSec !== undefined) {
          const untilStop = stopSec * 1000 - checkedAt;
          itemTimer = setTimeout(refetch, untilStop > 0 ? Math.min(untilStop, MAX_TIMEOUT_MS) : RETRY_MS);
        }
      },
      () => {
        if (mine === itemSeq) settled(null); // no On now line is better than a blocked player
      },
    );
  }

  function refetch(): Promise<void> {
    if (itemId === null) return Promise.resolve();
    checkedAt = Date.now();
    return fetchItem(itemId);
  }

  function load(id: number): Promise<CatalogItem | null> {
    if (id === itemId) return known;
    settled(null);
    itemId = id;
    clearTimeout(itemTimer);
    item = null;
    known = new Promise((resolve) => (settle = resolve));
    void fetchItem(id);
    return known;
  }

  // Timers may not run while the phone sleeps: check again when the app comes back.
  const onVisible = () => {
    if (document.visibilityState === 'visible') void refetch();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    get item() {
      return item;
    },
    get onNow() {
      return item?.kind === 'live' && item.now && item.now.stopSec * 1000 > checkedAt ? item.now : null;
    },
    load,
    refetch,
    destroy() {
      itemSeq++;
      clearTimeout(itemTimer);
      settled(null);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
