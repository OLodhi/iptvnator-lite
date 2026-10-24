import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { GuideMeta, GuideStatus } from '@tv/shared';

const guide = vi.hoisted(() => ({
  guideMeta: vi.fn(), saveGuidePrefs: vi.fn(), refreshGuide: vi.fn(), guideStatus: vi.fn(), whatsOn: vi.fn(), grid: vi.fn(), programmes: vi.fn(),
}));
vi.mock('$lib/guide', () => guide);

import Guide from './+page.svelte';

const status = (over: Partial<GuideStatus> = {}): GuideStatus => ({
  state: 'idle', fetchedAt: 1, source: 'xmltv', channels: 3, programmes: 10, linkedChannels: 3, error: null, ...over,
});
const meta = (over: Partial<GuideMeta> = {}): GuideMeta => ({
  providerId: 1,
  chips: [{ filter: 'all', label: 'All' }, { filter: 'favourites', label: 'Favourites' }],
  prefs: { view: 'grid', filter: 'all' },
  range: null,
  status: status(),
  ...over,
});

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  for (const f of Object.values(guide)) f.mockReset();
  guide.whatsOn.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('opens on the remembered view and saves changes', async () => {
  guide.guideMeta.mockResolvedValue(meta());
  guide.saveGuidePrefs.mockResolvedValue(undefined);
  app = mount(Guide, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('[data-testid="guide-grid"]')).not.toBeNull());
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.views button')];
  expect(tabs.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent?.trim()).toBe('Grid');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  tabs.find((b) => b.textContent?.trim() === "What's on")!.click();
  flushSync();
  expect(document.querySelector('[data-testid="guide-grid"]')).toBeNull();
  expect(guide.saveGuidePrefs).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(guide.saveGuidePrefs).toHaveBeenCalledWith({ view: 'whatson', filter: 'all' });
});

test('no guide shows refresh and polls', async () => {
  guide.guideMeta.mockResolvedValueOnce(meta({ status: null }));
  guide.guideMeta.mockResolvedValue(meta({ prefs: { view: 'whatson', filter: 'all' } }));
  guide.refreshGuide.mockResolvedValue(undefined);
  guide.guideStatus.mockResolvedValueOnce(status({ state: 'running', programmes: 0 })).mockResolvedValue(status());
  app = mount(Guide, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No TV guide yet'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh guide'))!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(guide.refreshGuide).toHaveBeenCalledWith(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(2);
  expect(guide.guideMeta).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain('No TV guide yet');
});

test('no provider links to settings', async () => {
  guide.guideMeta.mockResolvedValue(meta({ providerId: null, status: null }));
  app = mount(Guide, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('a[href="/settings/providers"]')).not.toBeNull());
});

test('a chip change saves prefs', async () => {
  guide.guideMeta.mockResolvedValue(meta({ prefs: { view: 'whatson', filter: 'all' } }));
  guide.saveGuidePrefs.mockResolvedValue(undefined);
  app = mount(Guide, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('.chips')).not.toBeNull());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  [...document.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent?.trim() === 'Favourites')!.click();
  await vi.advanceTimersByTimeAsync(500);
  expect(guide.saveGuidePrefs).toHaveBeenCalledWith({ view: 'whatson', filter: 'favourites' });
});

test('a pending prefs save is flushed once on unmount', async () => {
  guide.guideMeta.mockResolvedValue(meta());
  guide.saveGuidePrefs.mockResolvedValue(undefined);
  app = mount(Guide, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('.chips')).not.toBeNull());
  [...document.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent?.trim() === 'Favourites')!.click();
  flushSync();
  unmount(app);
  app = undefined;
  expect(guide.saveGuidePrefs).toHaveBeenCalledTimes(1);
  expect(guide.saveGuidePrefs).toHaveBeenCalledWith({ view: 'grid', filter: 'favourites' });
});

test('leaving the page while the refresh request is pending leaks no poll', async () => {
  guide.guideMeta.mockResolvedValue(meta({ status: null }));
  let release!: () => void;
  guide.refreshGuide.mockImplementation(() => new Promise<void>((r) => (release = r)));
  app = mount(Guide, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain('No TV guide yet'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh guide'))!.click();
  await vi.advanceTimersByTimeAsync(0);
  unmount(app);
  app = undefined;
  release();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(guide.guideStatus).not.toHaveBeenCalled();
});

test('starting mid-refresh polls, then reloads keeping the chosen view and filter', async () => {
  guide.guideMeta.mockResolvedValueOnce(meta({ status: status({ state: 'running', programmes: 0 }), prefs: { view: 'grid', filter: 'all' } }));
  guide.guideMeta.mockResolvedValue(meta({ prefs: { view: 'whatson', filter: 'favourites' } })); // stored prefs differ: the session's choice wins
  guide.guideStatus.mockResolvedValue(status());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  app = mount(Guide, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.body.textContent).toContain('No TV guide yet');
  await vi.advanceTimersByTimeAsync(3000);
  expect(guide.guideStatus).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(guide.guideMeta).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-testid="guide-grid"]')).not.toBeNull();
});
