import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { createOrientation } from './orientation.svelte.ts';

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('orientation', () => {
  it('reacts to the media query', async () => {
    const listeners = new Set<() => void>();
    const mql = {
      matches: false,
      addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
      removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn)),
    };
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
    const orientation = createOrientation();
    expect(window.matchMedia).toHaveBeenCalledWith('(orientation: landscape) and (pointer: coarse)');

    const seen: boolean[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(orientation.landscape);
      });
    });
    flushSync();
    expect(seen).toEqual([false]);

    mql.matches = true;
    listeners.forEach((fn) => fn());
    flushSync();
    expect(seen).toEqual([false, true]);

    stop();
    await Promise.resolve();
    expect(listeners.size).toBe(0);
    orientation.destroy();
  });

  it('is false without matchMedia', () => {
    expect(createOrientation().landscape).toBe(false);
  });
});
