import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ActionSheet from './ActionSheet.svelte';

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

test('an action closes the sheet and runs', () => {
  const run = vi.fn();
  props.actions = [{ label: 'Pin', run }];
  open();
  (document.querySelector('.sheet-action') as HTMLElement).click();
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
});
