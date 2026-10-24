import type { FastifyRequest } from 'fastify';

/** The seeded "Owner" user; every personal query is keyed by user from the start. */
export const DEFAULT_USER_ID = 1;

/** Resolves the acting user. Always the owner until Plan 4 adds sign-in. */
export function currentUserId(_req: FastifyRequest): number {
  return DEFAULT_USER_ID;
}
