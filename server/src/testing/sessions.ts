import type { SessionManager } from '../playback/sessions.ts';

/** A session manager with no sessions, for tests that don't play anything. Override methods as needed. */
export function stubSessions(overrides: Partial<SessionManager> = {}): SessionManager {
  return {
    start: () => Promise.reject(new Error('stubSessions: start() was not expected')),
    touch: () => false,
    release: async () => {},
    resolveFile: () => null,
    directSource: () => null,
    activeUpstreams: () => 0,
    reap: async () => {},
    stopAll: async () => {},
    ...overrides,
  };
}
