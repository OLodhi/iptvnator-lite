import { describe, expect, it } from 'vitest';
import { createPlayerState } from './state.svelte.ts';

function fakeVideo() {
  const video = document.createElement('video');
  const props: Record<string, unknown> = { currentTime: 0, duration: NaN, paused: true, ended: false, muted: false, seekable: { length: 0 }, error: null };
  for (const key of Object.keys(props)) Object.defineProperty(video, key, { get: () => props[key], configurable: true });
  return { video, props };
}

describe('player state', () => {
  it('follows media events and computes behindSec from seekable', () => {
    const { video, props } = fakeVideo();
    let offset = 100;
    const state = createPlayerState(video, () => offset);
    expect(state.window).toBeNull();
    expect(state.behindSec).toBe(0);
    expect(state.paused).toBe(true);

    props.paused = false;
    props.currentTime = 20;
    props.duration = Infinity;
    props.seekable = { length: 1, start: () => 0, end: () => 90 };
    video.dispatchEvent(new Event('play'));
    expect(state.paused).toBe(false);
    expect(state.positionSec).toBe(120);
    expect(state.window).toEqual({ startSec: 100, endSec: 190 });
    expect(state.behindSec).toBe(70);

    video.dispatchEvent(new Event('waiting'));
    expect(state.waiting).toBe(true);
    video.dispatchEvent(new Event('playing'));
    expect(state.waiting).toBe(false);

    props.duration = 3600;
    props.muted = true;
    video.dispatchEvent(new Event('durationchange'));
    video.dispatchEvent(new Event('volumechange'));
    expect(state.durationSec).toBe(3600);
    expect(state.muted).toBe(true);

    props.duration = Infinity;
    video.dispatchEvent(new Event('durationchange'));
    expect(state.durationSec).toBeNull();

    props.ended = true;
    video.dispatchEvent(new Event('ended'));
    expect(state.ended).toBe(true);

    offset = 0;
    props.currentTime = 500;
    video.dispatchEvent(new Event('seeked'));
    expect(state.positionSec).toBe(500);

    state.destroy();
    props.currentTime = 900;
    video.dispatchEvent(new Event('timeupdate'));
    expect(state.positionSec).toBe(500);
  });

  it('behindSec is 0 for a finite-duration VOD with a seekable window', () => {
    const { video, props } = fakeVideo();
    const state = createPlayerState(video, () => 0);
    props.duration = 3600;
    props.currentTime = 10;
    props.seekable = { length: 1, start: () => 0, end: () => 600 };
    video.dispatchEvent(new Event('progress'));
    expect(state.window).toEqual({ startSec: 0, endSec: 600 });
    expect(state.behindSec).toBe(0);
    state.destroy();
  });

  it('error exposes the MediaError code', () => {
    const { video, props } = fakeVideo();
    const state = createPlayerState(video, () => 0);
    expect(state.error).toBeNull();
    props.error = { code: 4 };
    video.dispatchEvent(new Event('error'));
    expect(state.error).toBe(4);
    state.destroy();
  });
});
