import { expect, test } from 'vitest';
import { load } from './+page.ts';

test('/guide redirects to Live, so an old link or Home Screen shortcut still lands', () => {
  expect(() => load({} as never)).toThrow(expect.objectContaining({ status: 308, location: '/browse/live' }));
});
