export interface TtlCache<V> {
  /** The cached value for key, or the result of load(), which is cached while it runs. A failed load is not kept. */
  get(key: number, load: () => Promise<V>): Promise<V>;
}

/** An in-memory cache of in-flight and finished loads that expires entries after ttlMs and drops the oldest past maxEntries. */
export function createTtlCache<V>(opts: { ttlMs: number; maxEntries: number; now: () => number }): TtlCache<V> {
  // A Map iterates in insertion order, so the first key is always the oldest.
  const entries = new Map<number, { at: number; value: Promise<V> }>();
  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && opts.now() - hit.at < opts.ttlMs) return hit.value;
      entries.delete(key);
      const value = load();
      const entry = { at: opts.now(), value };
      entries.set(key, entry);
      while (entries.size > opts.maxEntries) entries.delete(entries.keys().next().value!);
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return value;
    },
  };
}
