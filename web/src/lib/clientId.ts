const KEY = 'tv.clientId';
const VALID = /^[A-Za-z0-9_-]{1,64}$/;

let cached: string | undefined;

function generate(): string {
  try {
    const id = crypto.randomUUID();
    if (VALID.test(id)) return id;
  } catch {
    // fall through
  }
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('').slice(0, 32) || 'anon';
}

/** A per-browser id, kept in localStorage; falls back to an in-memory value if storage throws. */
export function getClientId(): string {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && VALID.test(stored)) return (cached = stored);
  } catch {
    // storage unavailable
  }
  cached = generate();
  try {
    localStorage.setItem(KEY, cached);
  } catch {
    // keep the in-memory value
  }
  return cached;
}
