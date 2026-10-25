import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { MediaTrack } from '@tv/shared';
import TrackSheet from './TrackSheet.svelte';

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

const t = (index: number, label: string, available = true): MediaTrack => ({ index, label, language: 'en', isDefault: false, forced: false, available });
const actions = () => [...document.querySelectorAll('button.sheet-action:not(.cancel)')] as HTMLButtonElement[];

test('track sheet lists Off and marks picture subtitles unavailable', () => {
  const onPick = vi.fn();
  app = mount(TrackSheet, {
    target: document.body,
    props: { open: true, kind: 'subtitles', tracks: [t(2, 'English'), t(3, 'Dutch (PGS)', false)], selected: null, onPick, onClose: vi.fn() },
  });
  flushSync();
  const buttons = actions();
  expect(buttons.map((b) => b.textContent?.replace('✓', '').trim())).toEqual(['Off', 'English', 'Dutch (PGS) (not supported on this device)']);
  expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
  expect(buttons[2]!.disabled).toBe(true);
  buttons[1]!.click();
  expect(onPick).toHaveBeenCalledWith(2);
  buttons[0]!.click();
  expect(onPick).toHaveBeenCalledWith(null);
});

test('audio has no Off entry and marks the selected track', () => {
  app = mount(TrackSheet, {
    target: document.body,
    props: { open: true, kind: 'audio', tracks: [t(0, 'English'), t(1, 'Dutch')], selected: 1, onPick: vi.fn(), onClose: vi.fn() },
  });
  flushSync();
  const buttons = actions();
  expect(buttons).toHaveLength(2);
  expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.sheet-title')?.textContent).toBe('Audio');
});
