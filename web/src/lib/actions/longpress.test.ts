import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import { longpress } from './longpress.ts';

let node: HTMLElement;
let onLongPress: Mock<() => void>;
let action: { destroy?: () => void };

function fire(type: string, x = 0, y = 0) {
  node.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  node = document.createElement('div');
  document.body.append(node);
  onLongPress = vi.fn<() => void>();
  action = longpress(node, { onLongPress }) as { destroy?: () => void };
});
afterEach(() => {
  action.destroy?.();
  node.remove();
  vi.useRealTimers();
});

test('fires after 500 ms', () => {
  fire('pointerdown');
  vi.advanceTimersByTime(499);
  expect(onLongPress).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onLongPress).toHaveBeenCalledTimes(1);
});

test('does not fire on a quick tap', () => {
  fire('pointerdown');
  vi.advanceTimersByTime(100);
  fire('pointerup');
  vi.advanceTimersByTime(1000);
  expect(onLongPress).not.toHaveBeenCalled();
});

test('cancels when the pointer moves more than 10 px', () => {
  fire('pointerdown', 100, 100);
  fire('pointermove', 105, 104);
  vi.advanceTimersByTime(200);
  fire('pointermove', 115, 100);
  vi.advanceTimersByTime(1000);
  expect(onLongPress).not.toHaveBeenCalled();
});

test('suppresses the click that follows a fired long press, once', () => {
  const clicks = vi.fn();
  document.addEventListener('click', clicks);
  fire('pointerdown');
  vi.advanceTimersByTime(500);
  fire('pointerup');
  fire('click');
  expect(clicks).not.toHaveBeenCalled();
  fire('click');
  expect(clicks).toHaveBeenCalledTimes(1);
  document.removeEventListener('click', clicks);
});

test('a normal tap click is not suppressed', () => {
  const clicks = vi.fn();
  document.addEventListener('click', clicks);
  fire('pointerdown');
  fire('pointerup');
  fire('click');
  expect(clicks).toHaveBeenCalledTimes(1);
  document.removeEventListener('click', clicks);
});

test('contextmenu is prevented to stop the native callout', () => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  node.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(true);
});

test('honours a custom ms', () => {
  action.destroy?.();
  action = longpress(node, { ms: 100, onLongPress }) as { destroy?: () => void };
  fire('pointerdown');
  vi.advanceTimersByTime(100);
  expect(onLongPress).toHaveBeenCalledTimes(1);
});
