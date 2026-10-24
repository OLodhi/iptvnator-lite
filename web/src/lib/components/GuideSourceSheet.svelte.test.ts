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
