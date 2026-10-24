const sessionPath = (sessionId: string, clientId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/${encodeURIComponent(clientId)}`;

export type HeartbeatOptions = {
  intervalMs?: number;
  fetchFn?: typeof fetch;
  /** Called once, when the server says the session no longer exists (404). Heartbeats then stop. */
  onGone: () => void;
};

/** POSTs a heartbeat every `intervalMs` until the returned function is called or the session is gone. */
export function startHeartbeat(sessionId: string, clientId: string, opts: HeartbeatOptions): () => void {
  const { intervalMs = 15000, fetchFn = (...a: Parameters<typeof fetch>) => fetch(...a), onGone } = opts;
  let stopped = false;
  const timer = setInterval(async () => {
    try {
      const res = await fetchFn(`${sessionPath(sessionId, clientId)}/heartbeat`, { method: 'POST' });
      if (res.status === 404 && !stopped) {
        stop();
        onGone();
      }
    } catch {
      // transient network trouble: try again next tick
    }
  }, intervalMs);
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}

/** Best-effort release; survives page unload. Never throws. */
export async function releaseSession(sessionId: string, clientId: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<void> {
  try {
    await fetchFn(sessionPath(sessionId, clientId), { method: 'DELETE', keepalive: true });
  } catch {
    // nothing useful to do
  }
}
