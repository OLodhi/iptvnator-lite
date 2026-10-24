import type { SearchResults } from '@tv/shared';
import { ApiClientError } from './api.ts';
import { messageFor } from './messages.ts';

export type SearchState = {
  /** The text as typed (untrimmed), for the input. */
  query: string;
  /** null until a search has completed for the current query. */
  results: SearchResults | null;
  loading: boolean;
  error: string | null;
};

type Deps = {
  search: (q: string, signal?: AbortSignal) => Promise<SearchResults>;
  debounceMs?: number;
};

/** Debounced search with stale-response protection: only the latest query may update the state. */
export function createSearchModel(deps: Deps) {
  const debounceMs = deps.debounceMs ?? 250;
  let state: SearchState = { query: '', results: null, loading: false, error: null };
  const subscribers = new Set<(s: SearchState) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let seq = 0;

  const set = (patch: Partial<SearchState>) => {
    state = { ...state, ...patch };
    for (const fn of subscribers) fn(state);
  };

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    seq++;
  }

  async function run(q: string) {
    const mine = ++seq;
    controller = new AbortController();
    set({ loading: true, error: null });
    try {
      const results = await deps.search(q, controller.signal);
      if (mine === seq) set({ results, loading: false });
    } catch (err) {
      if (mine !== seq) return;
      set({
        loading: false,
        error: err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.',
      });
    }
  }

  function setQuery(query: string) {
    cancel();
    const q = query.trim();
    if (q === '') {
      set({ query, results: null, loading: false, error: null });
      return;
    }
    set({ query, loading: true, error: null });
    timer = setTimeout(() => void run(q), debounceMs);
  }

  /** Re-runs the current query immediately. */
  function retry() {
    const q = state.query.trim();
    if (q === '') return;
    cancel();
    void run(q);
  }

  return {
    setQuery,
    retry,
    /** Cancels pending and in-flight work; call when the screen goes away. */
    destroy: cancel,
    subscribe(fn: (s: SearchState) => void) {
      subscribers.add(fn);
      fn(state);
      return () => void subscribers.delete(fn);
    },
  };
}
