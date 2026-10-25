import type { ApiClientError } from './api.ts';

/** What the message is about, when the copy depends on it: what was playing. A channel when left out. */
export type MessageContext = { kind?: 'live' | 'catchup' | 'movie' | 'episode' };

export function messageFor(err: Pick<ApiClientError, 'code' | 'details'>, context: MessageContext = {}): string {
  switch (err.code) {
    case 'PROVIDER_AUTH_FAILED':
      return "Your provider didn't accept that username and password.";
    case 'PROVIDER_UNREACHABLE':
      return "Couldn't reach that server. Check the address.";
    case 'PROVIDER_BAD_RESPONSE':
      return 'That address answered, but not like an IPTV provider.';
    case 'PROVIDER_CONNECTION_LIMIT': {
      const limit = (err.details as { limit?: unknown } | undefined)?.limit;
      const allows = typeof limit === 'number' ? `${limit} ${limit === 1 ? 'stream' : 'streams'}` : 'only a limited number of streams';
      return `Your provider allows ${allows} at a time. Something is already playing on another device.`;
    }
    case 'STREAM_START_TIMEOUT':
    case 'UPSTREAM_ERROR':
      return context.kind === undefined || context.kind === 'live'
        ? "This channel isn't responding right now."
        : "This video isn't responding right now.";
    case 'NOT_IPTVNATOR':
      return "That file isn't an IPTVnator database.";
    case 'NO_MATCHING_PLAYLIST':
      return "That IPTVnator file doesn't contain this provider.";
    case 'IMPORT_TOO_LARGE':
      return 'That file is too large to import.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
