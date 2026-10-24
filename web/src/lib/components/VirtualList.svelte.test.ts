import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Harness from './testing/VirtualListHarness.svelte';

let scrollY = 0;
let app: ReturnType<typeof mount> | undefined;
let props = $state({ items: [] as string[], onEnd: vi.fn() });

const list = (prefix: string, n = 100) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function scrollTo(y: number) {
  scrollY = y;
  window.dispatchEvent(new Event('scroll'));
  flushSync();
}

beforeEach(() => {
  scrollY = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ top: -scrollY, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: -scrollY, toJSON() {} }) as DOMRect,
  );
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  props.items = list("a");
  props.onEnd = vi.fn();
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function render() {
  app = mount(Harness, { target: document.body, props });
  flushSync();
}

test('renders only a window of rows', () => {
  render();
  const rows = document.querySelectorAll('.r').length;
  expect(rows).toBeGreaterThan(0);
  expect(rows).toBeLessThan(30);
});

test('onEnd fires only within 3 rows of the true end (overscan excluded)', () => {
  render();
  expect(props.onEnd).not.toHaveBeenCalled();
  scrollTo(4200); // last visible row 96 of 100: 4 rows away
  expect(props.onEnd).not.toHaveBeenCalled();
  scrollTo(4250); // last visible row 97: 3 rows away
  expect(props.onEnd).toHaveBeenCalledTimes(1);
  scrollTo(4400);
  expect(props.onEnd).toHaveBeenCalledTimes(1); // once per list
});

test('onEnd fires again for a new list of the same length', () => {
  render();
  scrollTo(4400);
  expect(props.onEnd).toHaveBeenCalledTimes(1);
  props.items = list('b');
  flushSync();
  expect(props.onEnd).toHaveBeenCalledTimes(2);
});

test('onEnd fires again when the list is refreshed with the same rows', () => {
  render();
  scrollTo(4400);
  props.items = [...props.items];
  flushSync();
  expect(props.onEnd).toHaveBeenCalledTimes(2);
});

test('appending a page fires onEnd again only when the new end is reached', () => {
  render();
  scrollTo(4400);
  props.items = [...props.items, ...list('c')];
  flushSync();
  expect(props.onEnd).toHaveBeenCalledTimes(1);
  scrollTo(9400);
  expect(props.onEnd).toHaveBeenCalledTimes(2);
});
