import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const guide = vi.hoisted(() => ({ guideSources: vi.fn(), setGuideSource: vi.fn() }));
vi.mock('$lib/guide', () => guide);

import GuideSourceSheet from './GuideSourceSheet.svelte';

let app: ReturnType<typeof mount> | undefined;
const onMapped = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  guide.guideSources.mockReset().mockResolvedValue([{ key: 'bbc1.uk', name: 'BBC One' }]);
  guide.setGuideSource.mockReset().mockResolvedValue(undefined);
  onMapped.mockReset();
  onClose.mockReset();
  app = mount(GuideSourceSheet, {
    target: document.body,
    props: { open: true, item: { id: 7, providerId: 3, displayName: 'BBC 1 HD' }, onClose, onMapped },
  });
  flushSync();
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function type(q: string, wait: number) {
  const input = document.querySelector('input') as HTMLInputElement;
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  await vi.advanceTimersByTimeAsync(wait);
  flushSync();
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.result')];

test('searches and maps', async () => {
  await type('bbc', 250);
  expect(guide.guideSources).toHaveBeenCalledWith(3, 'bbc', expect.anything());
  buttons().find((b) => b.textContent?.includes('bbc1.uk'))!.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(guide.setGuideSource).toHaveBeenCalledWith(7, 'bbc1.uk');
  expect(onMapped).toHaveBeenCalled();
  expect(document.body.textContent).toContain('Guide will update in a minute or two');
});

test('Automatic matching clears the map', async () => {
  buttons().find((b) => b.textContent?.includes('Automatic matching'))!.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(guide.setGuideSource).toHaveBeenCalledWith(7, null);
});

test('does not search before the debounce', async () => {
  await type('bb', 200);
  expect(guide.guideSources).not.toHaveBeenCalledWith(3, 'bb', expect.anything());
});

test('a stale response after the box is cleared is dropped', async () => {
  let resolve!: (v: { key: string; name: string }[]) => void;
  guide.guideSources.mockReturnValue(new Promise((r) => (resolve = r)));
  await type('bbc', 250);
  await type('', 0);
  resolve([{ key: 'late.uk', name: 'Late' }]);
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(buttons().some((b) => b.textContent?.includes('late.uk'))).toBe(false);
});

test('a new pick clears the previous error and success message', async () => {
  guide.setGuideSource.mockRejectedValueOnce(new Error('x'));
  buttons()[0]!.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(document.querySelector('[role=alert]')).toBeTruthy();
  buttons()[0]!.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(document.querySelector('[role=alert]')).toBeNull();
  expect(document.querySelector('[role=status]')).toBeTruthy();
});

test('focuses the search box and keeps long result lists inside a scrolling list', async () => {
  expect(document.activeElement).toBe(document.querySelector('input'));
  guide.guideSources.mockResolvedValue(Array.from({ length: 80 }, (_, i) => ({ key: `k${i}`, name: `Channel ${i}` })));
  await type('ch', 250);
  const list = document.querySelector('.sheet > .list')!;
  expect(list.querySelectorAll('.result').length).toBe(81);
  expect(document.querySelector('.sheet > .cancel')).toBeTruthy(); // footer sits outside the scrolling list
  expect(list.contains(document.querySelector('.cancel'))).toBe(false);
});
