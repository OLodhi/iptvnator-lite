import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import LivePill from './LivePill.svelte';

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

test('pill turns grey with −2:30 at behindSec 150 and calls onGoLive', () => {
  const onGoLive = vi.fn();
  const props = $state({ behindSec: 3, onGoLive });
  app = mount(LivePill, { target: document.body, props });
  flushSync();
  const btn = document.querySelector('button') as HTMLButtonElement;
  expect(btn.textContent?.trim()).toBe('● LIVE');
  expect(btn.getAttribute('aria-label')).toBe('Go to live');
  expect(btn.classList.contains('live')).toBe(true);

  props.behindSec = 150;
  flushSync();
  expect(btn.textContent?.trim()).toBe('● −2:30');
  expect(btn.classList.contains('behind')).toBe(true);
  btn.click();
  expect(onGoLive).toHaveBeenCalledTimes(1);

  props.behindSec = 15;
  flushSync();
  expect(btn.textContent?.trim()).toBe('● −0:15');
});
