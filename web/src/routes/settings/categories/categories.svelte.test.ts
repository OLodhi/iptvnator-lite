import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { CurationView } from '@tv/shared';

const nav = vi.hoisted(() => ({ beforeNavigate: vi.fn(), goto: vi.fn() }));
const me = vi.hoisted(() => ({ curation: vi.fn(), saveCuration: vi.fn() }));
const provider = vi.hoisted(() => ({ firstProvider: vi.fn() }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/categories?kind=live') } }));
vi.mock('$lib/me', () => me);
vi.mock('$lib/provider', () => provider);

import Categories from './+page.svelte';

const view = (): CurationView => ({
  kind: 'live',
  style: 'untagged',
  newCount: 0,
  groups: [],
  untagged: [{ id: 1, remoteId: '1', name: 'News', displayName: 'News', itemCount: 3, visible: true, isNew: false }],
});

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  nav.beforeNavigate.mockReset();
  me.curation.mockReset().mockImplementation(async () => view());
  provider.firstProvider.mockReset().mockResolvedValue({ id: 7, name: 'P', kind: 'xtream', maxConnections: null, lastSyncedAt: null });
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

test('first mount fetches the curation once', async () => {
  app = mount(Categories, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('News'));
  await new Promise((r) => setTimeout(r, 50));
  expect(me.curation).toHaveBeenCalledTimes(1);
  expect(me.curation).toHaveBeenCalledWith(7, 'live');
});

test('ticking a category and unticking it does not raise the unsaved-changes prompt', async () => {
  app = mount(Categories, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('News'));
  const box = document.querySelector<HTMLInputElement>('.cat input')!;
  box.click();
  box.click();
  await new Promise((r) => setTimeout(r, 20));
  const guard = nav.beforeNavigate.mock.calls[0]![0] as (n: { to: { url: URL }; cancel: () => void }) => void;
  const cancel = vi.fn();
  guard({ to: { url: new URL('http://localhost/search') }, cancel });
  expect(cancel).not.toHaveBeenCalled();
});
