import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { SearchResults } from '@tv/shared';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/search'), state: {} }));
const replaceState = vi.hoisted(() => vi.fn());
const me = vi.hoisted(() => ({ search: vi.fn(), favourite: vi.fn(), unfavourite: vi.fn() }));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$app/navigation', () => ({ replaceState }));
vi.mock('$lib/me', () => me);

import Search from './+page.svelte';

const channel = (name: string): SearchResults => ({
  live: [{ id: 1, providerId: 1, kind: 'live', name, displayName: name, logoUrl: null, catchupDays: null, year: null, rating: null, favourite: false }],
  movie: [],
  series: [],
  categories: [],
});

let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  replaceState.mockReset();
  me.search.mockReset().mockImplementation(async (q: string) => channel(`Found ${q}`));
  app = mount(Search, { target: document.body });
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

/** Types `text` one character at a time, with no pause between keystrokes. */
function type(text: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  for (let i = 1; i <= text.length; i++) {
    input.value = text.slice(0, i);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

test('typing ten characters quickly updates the URL once, when the search runs', async () => {
  type('abcdefghij');
  expect(replaceState).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(me.search).toHaveBeenCalledTimes(1));
  expect(replaceState).toHaveBeenCalledTimes(1);
  expect(String(replaceState.mock.calls[0]![0])).toBe('http://localhost/search?q=abcdefghij');
  await new Promise((r) => setTimeout(r, 300)); // well past another debounce
  expect(replaceState).toHaveBeenCalledTimes(1);
});

test('a URL update that throws does not stop the results from showing', async () => {
  // WebKit throws once a page makes about 100 history calls in a short window.
  replaceState.mockImplementation(() => {
    throw new DOMException('Attempt to use history.replaceState() more than 100 times per 10 seconds', 'SecurityError');
  });
  type('sky');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Found sky'));
  expect(replaceState).toHaveBeenCalled();
});
