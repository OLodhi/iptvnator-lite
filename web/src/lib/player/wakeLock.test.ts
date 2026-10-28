import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepAwakeWhileMuted } from './wakeLock.ts';

type FakeLock = { released: boolean; release: () => Promise<void> };

function fakeWakeLock(request?: () => Promise<FakeLock>) {
  const locks: FakeLock[] = [];
  const fn = vi.fn(
    request ??
      (async () => {
        const lock: FakeLock = { released: false, release: async () => { lock.released = true; } };
        locks.push(lock);
        return lock;
      }),
  );
  Object.defineProperty(navigator, 'wakeLock', { value: { request: fn }, configurable: true });
  return { request: fn, locks, held: () => locks.filter((l) => !l.released).length };
}

function fakeVideo() {
  const video = document.createElement('video');
  const props: Record<string, unknown> = { paused: true, ended: false, muted: false, webkitCurrentPlaybackTargetIsWireless: false };
  for (const key of Object.keys(props)) Object.defineProperty(video, key, { get: () => props[key], configurable: true });
  return { video, props };
}

let visibility: DocumentVisibilityState = 'visible';
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
});

afterEach(() => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('keepAwakeWhileMuted', () => {
  it('holds the screen awake while a muted video plays, and lets go on unmute or pause', async () => {
    const wake = fakeWakeLock();
    const { video, props } = fakeVideo();
    keepAwakeWhileMuted(video);

    props.paused = false;
    video.dispatchEvent(new Event('play'));
    await settle();
    expect(wake.request).not.toHaveBeenCalled(); // with sound, Safari keeps the screen on itself

    props.muted = true;
    video.dispatchEvent(new Event('volumechange'));
    await settle();
    expect(wake.request).toHaveBeenCalledWith('screen');
    expect(wake.held()).toBe(1);

    props.muted = false;
    video.dispatchEvent(new Event('volumechange'));
    await settle();
    expect(wake.held()).toBe(0);

    props.muted = true;
    video.dispatchEvent(new Event('volumechange'));
    await settle();
    expect(wake.held()).toBe(1);
    props.paused = true;
    video.dispatchEvent(new Event('pause'));
    await settle();
    expect(wake.held()).toBe(0);

    props.paused = false;
    video.dispatchEvent(new Event('play'));
    await settle();
    props.ended = true;
    video.dispatchEvent(new Event('ended'));
    await settle();
    expect(wake.held()).toBe(0);
  });

  it('takes the lock again when the page shows after Safari dropped it', async () => {
    const wake = fakeWakeLock();
    const { video, props } = fakeVideo();
    props.paused = false;
    props.muted = true;
    keepAwakeWhileMuted(video);
    await settle();
    expect(wake.held()).toBe(1);

    // Safari lets go of a screen lock itself when the page is hidden.
    visibility = 'hidden';
    wake.locks[0].released = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(2);
    expect(wake.held()).toBe(1);
  });

  it('lets the phone sleep while the video plays on AirPlay', async () => {
    const wake = fakeWakeLock();
    const { video, props } = fakeVideo();
    props.paused = false;
    props.muted = true;
    keepAwakeWhileMuted(video);
    await settle();
    expect(wake.held()).toBe(1);

    props.webkitCurrentPlaybackTargetIsWireless = true;
    video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
    await settle();
    expect(wake.held()).toBe(0);
  });

  it('lets go of a lock that arrives after the video was unmuted', async () => {
    let grant!: (lock: FakeLock) => void;
    const lock: FakeLock = { released: false, release: async () => { lock.released = true; } };
    const wake = fakeWakeLock(() => new Promise((resolve) => { grant = resolve; }));
    const { video, props } = fakeVideo();
    props.paused = false;
    props.muted = true;
    keepAwakeWhileMuted(video);
    expect(wake.request).toHaveBeenCalledTimes(1);

    props.muted = false;
    video.dispatchEvent(new Event('volumechange'));
    grant(lock);
    await settle();
    expect(lock.released).toBe(true);
  });

  it('stopping lets go and stops listening', async () => {
    const wake = fakeWakeLock();
    const { video, props } = fakeVideo();
    props.paused = false;
    props.muted = true;
    const stop = keepAwakeWhileMuted(video);
    await settle();
    expect(wake.held()).toBe(1);

    stop();
    await settle();
    expect(wake.held()).toBe(0);
    video.dispatchEvent(new Event('play'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without the API, and a refused request is not retried in a loop', async () => {
    const { video, props } = fakeVideo();
    props.paused = false;
    props.muted = true;
    expect(() => keepAwakeWhileMuted(video)()).not.toThrow();

    const wake = fakeWakeLock(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    keepAwakeWhileMuted(video);
    await settle();
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(1);
  });
});
