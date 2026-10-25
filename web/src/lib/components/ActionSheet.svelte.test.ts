import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ActionSheet from './ActionSheet.svelte';
import source from './ActionSheet.svelte?raw';

let app: ReturnType<typeof mount> | undefined;
let props = $state({ open: false, title: 'Sky News', actions: [] as { label: string; run: () => void }[], onClose: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
  props.open = false;
  props.actions = [];
  props.onClose = vi.fn();
  app = mount(ActionSheet, { target: document.body, props });
  flushSync();
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function open() {
  props.open = true;
  flushSync();
}
const backdrop = () => document.querySelector('.backdrop') as HTMLElement;

test('ignores backdrop clicks for 300 ms after opening, then closes', () => {
  open();
  backdrop().click();
  expect(props.onClose).not.toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  backdrop().click();
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

/** The declarations of a rule in the component's own styles, which jsdom doesn't apply. */
function rule(selector: string): string {
  const css = source.slice(source.indexOf('<style>'));
  const at = css.indexOf(`\n  ${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
}

test('a long sheet stays within the viewport: its actions scroll, and Cancel stays below them', () => {
  props.actions = [{ label: 'Pin', run: vi.fn() }];
  open();
  const sheet = document.querySelector('.sheet')!;
  const list = sheet.querySelector('.sheet-list')!;
  expect(list.querySelector('.sheet-action')?.textContent).toBe('Pin');
  const cancel = sheet.querySelector('.cancel')!;
  expect(list.contains(cancel)).toBe(false);
  expect(sheet.lastElementChild).toBe(cancel);
  // Clear of the top safe area: vh where dvh isn't known, else the viewport as it is now (Safari's bars come and go).
  expect(rule('.sheet')).toMatch(
    /max-height: calc\(100vh - env\(safe-area-inset-top\) - 16px\);\s*max-height: calc\(100dvh - env\(safe-area-inset-top\) - 16px\);/,
  );
  expect(rule('.sheet')).toContain('display: flex;');
  expect(rule('.sheet-list')).toContain('min-height: 0;');
  expect(rule('.sheet-list')).toContain('overflow-y: auto;');
  expect(rule('.sheet-list')).toContain('-webkit-overflow-scrolling: touch;');
});

test('an action closes the sheet and runs', () => {
  const run = vi.fn();
  props.actions = [{ label: 'Pin', run }];
  open();
  (document.querySelector('.sheet-action') as HTMLElement).click();
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
});
