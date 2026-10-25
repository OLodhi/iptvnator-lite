import { afterEach, describe, expect, it, vi } from 'vitest';
import { canAirPlay, canPip, setNowPlaying, showAirPlay, togglePip } from './system.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { mediaSession?: unknown }).mediaSession;
  delete (window as { WebKitPlaybackTargetAvailabilityEvent?: unknown }).WebKitPlaybackTargetAvailabilityEvent;
});

describe('system integrations', () => {
  it('setNowPlaying is a no-op without mediaSession and sets metadata and handlers with it', () => {
    expect(() => setNowPlaying({ title: 'x' }, { play: () => {} })).not.toThrow();

    class FakeMetadata {
      constructor(public init: unknown) {}
    }
    vi.stubGlobal('MediaMetadata', FakeMetadata);
    const handlers = new Map<string, (() => void) | null>();
    const session = { metadata: null as unknown, setActionHandler: vi.fn((name: string, fn: (() => void) | null) => handlers.set(name, fn)) };
    Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });

    const play = vi.fn();
    setNowPlaying({ title: 'News', artist: 'BBC', artworkUrl: '/logo.png' }, { play });
    expect((session.metadata as FakeMetadata).init).toEqual({ title: 'News', artist: 'BBC', artwork: [{ src: '/logo.png' }] });
    expect(handlers.get('play')).toBe(play);
    expect(handlers.get('pause')).toBeNull();

    setNowPlaying(null, { play });
    expect(session.metadata).toBeNull();
    expect(handlers.get('play')).toBeNull();
  });

  it('PiP and AirPlay are false without the APIs', async () => {
    const video = document.createElement('video');
    expect(canPip(video)).toBe(false);
    expect(canAirPlay()).toBe(false);
    await expect(togglePip(video)).resolves.toBeUndefined();
    expect(() => showAirPlay(video)).not.toThrow();
  });

  it('uses webkitSetPresentationMode when present, else the standard PiP API', async () => {
    const webkit = document.createElement('video') as HTMLVideoElement & Record<string, unknown>;
    webkit.webkitSetPresentationMode = vi.fn();
    webkit.webkitPresentationMode = 'inline';
    expect(canPip(webkit)).toBe(true);
    await togglePip(webkit);
    expect(webkit.webkitSetPresentationMode).toHaveBeenCalledWith('picture-in-picture');

    const std = document.createElement('video');
    std.requestPictureInPicture = vi.fn().mockResolvedValue({});
    expect(canPip(std)).toBe(true);
    await togglePip(std);
    expect(std.requestPictureInPicture).toHaveBeenCalled();

    Object.defineProperty(document, 'pictureInPictureElement', { value: std, configurable: true });
    document.exitPictureInPicture = vi.fn().mockResolvedValue(undefined);
    await togglePip(std);
    expect(document.exitPictureInPicture).toHaveBeenCalled();
    delete (document as { pictureInPictureElement?: unknown }).pictureInPictureElement;
    delete (document as { exitPictureInPicture?: unknown }).exitPictureInPicture;
  });

  it('togglePip resolves when requestPictureInPicture or exitPictureInPicture rejects', async () => {
    const video = document.createElement('video');
    video.requestPictureInPicture = vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    await expect(togglePip(video)).resolves.toBeUndefined();

    Object.defineProperty(document, 'pictureInPictureElement', { value: video, configurable: true });
    document.exitPictureInPicture = vi.fn().mockRejectedValue(new DOMException('no', 'InvalidStateError'));
    await expect(togglePip(video)).resolves.toBeUndefined();
    delete (document as { pictureInPictureElement?: unknown }).pictureInPictureElement;
    delete (document as { exitPictureInPicture?: unknown }).exitPictureInPicture;
  });

  it('AirPlay is available when WebKit announces playback targets and opens the picker', () => {
    (window as unknown as Record<string, unknown>).WebKitPlaybackTargetAvailabilityEvent = class {};
    expect(canAirPlay()).toBe(true);
    const video = document.createElement('video') as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void };
    video.webkitShowPlaybackTargetPicker = vi.fn();
    showAirPlay(video);
    expect(video.webkitShowPlaybackTargetPicker).toHaveBeenCalled();
  });
});
