import type { ApiClientError } from './api.ts';

export function messageFor(err: Pick<ApiClientError, 'code' | 'details'>): string {
  switch (err.code) {
    case 'PROVIDER_AUTH_FAILED':
      return "Your provider didn't accept that username and password.";
    case 'PROVIDER_UNREACHABLE':
      return "Couldn't reach that server. Check the address.";
    case 'PROVIDER_BAD_RESPONSE':
      return 'That address answered, but not like an IPTV provider.';
    case 'PROVIDER_CONNECTION_LIMIT': {
      const limit = (err.details as { limit?: unknown } | undefined)?.limit;
      return typeof limit === 'number'
        ? `Your provider allows ${limit} ${limit === 1 ? 'stream' : 'streams'} at a time, and it’s in use.`
        : 'Your provider allows only a limited number of streams at a time, and it’s in use.';
    }
    case 'STREAM_START_TIMEOUT':
    case 'UPSTREAM_ERROR':
      return "This channel isn't responding right now.";
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
