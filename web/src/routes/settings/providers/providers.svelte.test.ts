import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { GuideStatus, ProviderSummary } from '@tv/shared';

const providers = vi.hoisted(() => ({ firstProvider: vi.fn() }));
const guide = vi.hoisted(() => ({ guideStatus: vi.fn(), refreshGuide: vi.fn() }));
const me = vi.hoisted(() => ({ importIptvnator: vi.fn(), refresh: vi.fn() }));
vi.mock('$lib/provider', () => providers);
vi.mock('$lib/guide', () => guide);
vi.mock('$lib/me', () => me);

import Providers from './+page.svelte';

const provider: ProviderSummary = { id: 3, name: 'My TV', kind: 'xtream', maxConnections: 1, lastSyncedAt: null };
const FETCHED = Date.UTC(2026, 9, 25, 7, 30);
const status = (over: Partial<GuideStatus> = {}): GuideStatus => ({
  state: 'idle', fetchedAt: FETCHED, source: 'xmltv', channels: 3, programmes: 250_888, linkedChannels: 3, error: null, ...over,
});

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  providers.firstProvider.mockReset().mockResolvedValue(provider);
  guide.guideStatus.mockReset().mockResolvedValue(status());
  guide.refreshGuide.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function open() {
  app = mount(Providers, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
}
const guideCard = () => document.querySelector<HTMLElement>('.guide')!;
const guideText = () => guideCard().textContent?.replace(/\s+/g, ' ').trim() ?? '';
const refreshButton = () => [...guideCard().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Refresh guide')!;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

test('the guide line says when it was updated and how many programmes it holds', async () => {
  await open();
  expect(guide.guideStatus).toHaveBeenCalledWith(3);
  expect(guideText()).toContain(`Updated ${new Date(FETCHED).toLocaleString()} · ${(250_888).toLocaleString()} programmes`);
  expect(refreshButton().disabled).toBe(false);
  expect(guideCard().querySelector('[role="alert"]')).toBeNull();
});

test('a guide never fetched is not loaded yet', async () => {
  guide.guideStatus.mockResolvedValue(status({ fetchedAt: null, source: null, programmes: 0 }));
  await open();
  expect(guideText()).toContain('Not loaded yet');
  expect(guideText()).not.toContain('Updated');
});

test('a failed last attempt shows its error', async () => {
  guide.guideStatus.mockResolvedValue(status({ state: 'failed', error: 'XMLTV: provider unreachable' }));
  await open();
  expect(guideCard().querySelector('[role="alert"]')?.textContent).toContain('XMLTV: provider unreachable');
  expect(guideText()).toContain('Updated'); // the previous guide is still there
  expect(refreshButton().disabled).toBe(false);
});

test('a running refresh says Updating…, disables the button and is followed until it settles', async () => {
  guide.guideStatus.mockResolvedValueOnce(status({ state: 'running' })).mockResolvedValue(status({ programmes: 9 }));
  await open();
  expect(guideText()).toContain('Updating…');
  expect(refreshButton().disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(2);
  expect(guideText()).toContain('9 programmes');
  expect(refreshButton().disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(2); // idle: polling stopped
});

test('Refresh guide posts, stays disabled while the request and the refresh run, and polls until idle', async () => {
  await open();
  const post = deferred<void>();
  guide.refreshGuide.mockReturnValue(post.promise);
  guide.guideStatus.mockResolvedValueOnce(status({ state: 'running' })).mockResolvedValue(status({ programmes: 7 }));
  refreshButton().click();
  await vi.advanceTimersByTimeAsync(0);
  expect(guide.refreshGuide).toHaveBeenCalledWith(3);
  expect(refreshButton().disabled).toBe(true); // request in flight
  post.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(guideText()).toContain('Updating…');
  expect(refreshButton().disabled).toBe(true); // refresh running
  await vi.advanceTimersByTimeAsync(1000);
  expect(guideText()).toContain('7 programmes');
  expect(refreshButton().disabled).toBe(false);
  const calls = guide.guideStatus.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(calls);
});

test('a failed Refresh guide request shows the error and frees the button', async () => {
  await open();
  guide.refreshGuide.mockRejectedValue(new Error('down'));
  refreshButton().click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/went wrong/);
  expect(refreshButton().disabled).toBe(false);
});

test('leaving the page stops the guide polling', async () => {
  guide.guideStatus.mockResolvedValue(status({ state: 'running' }));
  await open();
  await vi.advanceTimersByTimeAsync(1000);
  const calls = guide.guideStatus.mock.calls.length;
  unmount(app!);
  app = undefined;
  await vi.advanceTimersByTimeAsync(5000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(calls);
});

test('a status that arrives after leaving the page starts no polling', async () => {
  const first = deferred<GuideStatus>();
  guide.guideStatus.mockReturnValueOnce(first.promise).mockResolvedValue(status({ state: 'running' }));
  await open();
  unmount(app!);
  app = undefined;
  first.resolve(status({ state: 'running' }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(1);
});
