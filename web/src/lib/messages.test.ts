import { expect, test } from 'vitest';
import { ApiClientError } from './api.ts';
import { messageFor } from './messages.ts';

const err = (code: string, details?: unknown) => new ApiClientError(400, code, 'raw server text', details);

test('messageFor gives plain-English copy per code', () => {
  expect(messageFor(err('PROVIDER_AUTH_FAILED'))).toBe("Your provider didn't accept that username and password.");
  expect(messageFor(err('PROVIDER_UNREACHABLE'))).toBe("Couldn't reach that server. Check the address.");
  expect(messageFor(err('PROVIDER_BAD_RESPONSE'))).toBe('That address answered, but not like an IPTV provider.');
  expect(messageFor(err('PROVIDER_CONNECTION_LIMIT', { limit: 1 }))).toBe('Your provider allows 1 stream at a time, and it’s in use.');
  expect(messageFor(err('STREAM_START_TIMEOUT'))).toBe("This channel isn't responding right now.");
  expect(messageFor(err('UPSTREAM_ERROR'))).toBe("This channel isn't responding right now.");
  expect(messageFor(err('SOMETHING_ELSE'))).toBe('Something went wrong. Please try again.');
});

test('messageFor handles a connection limit without details', () => {
  expect(messageFor(err('PROVIDER_CONNECTION_LIMIT'))).toBe('Your provider allows only a limited number of streams at a time, and it’s in use.');
});
