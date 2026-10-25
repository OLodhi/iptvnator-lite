import { afterEach, expect, test, vi } from 'vitest';
import { createRawSnippet, mount, unmount } from 'svelte';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/browse/live/4') }));
vi.mock('$app/state', () => ({ page: route }));

import Layout from './+layout.svelte';

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

test('the tab bar has five tabs: Live, Movies, Series, Search, Settings', () => {
  const children = createRawSnippet(() => ({ render: () => '<p>page</p>' }));
  app = mount(Layout, { target: document.body, props: { children } });
  const tabs = [...document.querySelectorAll<HTMLAnchorElement>('.tabbar a')];
  expect(tabs.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
    ['Live', '/browse/live'],
    ['Movies', '/browse/movie'],
    ['Series', '/browse/series'],
    ['Search', '/search'],
    ['Settings', '/settings'],
  ]);
  expect(tabs.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent)).toEqual(['Live']);
});
