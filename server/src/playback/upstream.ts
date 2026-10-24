import { setTimeout as sleep } from 'node:timers/promises';

/** Statuses a provider uses to refuse a connection over the account's limit. */
export const LIMIT_STATUSES: readonly number[] = [403, 429, 503];
// A provider notices a closed connection a moment after it closes, so a request that follows one straight
// away can still be refused for being over the limit.
export const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 2000];
/** What a proxy passes on from the provider's response. Everything else (cookies, server names, ...) stays on the server. */
export const MIRRORED_HEADERS: readonly string[] = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

/**
 * fetch() that, while the provider answers with a LIMIT_STATUSES status, cancels that body, waits the next delay and tries again.
 * Returns the first other response, or the last refusal once the delays run out. Aborting init.signal stops it (rejects).
 */
export async function fetchWithLimitRetry(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<Response> {
  for (const delayMs of delaysMs) {
    const res = await fetch(url, init);
    if (!LIMIT_STATUSES.includes(res.status)) return res;
    await res.body?.cancel().catch(() => {});
    await sleep(delayMs, undefined, { signal: init.signal });
  }
  return fetch(url, init);
}
