import { expect, test, vi } from 'vitest';
import { attachStream, prefersNativeHls } from './attach.ts';

function fakeHls(supported: boolean) {
  const inst = {
    loadSource: vi.fn(),
    attachMedia: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    startLoad: vi.fn(),
    recoverMediaError: vi.fn(),
    subtitleTracks: [] as unknown[],
    subtitleTrack: -1,
    subtitleDisplay: true,
  };
  const Hls = vi.fn(function () {
    return inst;
  }) as any;
  Hls.isSupported = () => supported;
  Hls.Events = { ERROR: 'hlsError' };
  Hls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  return { Hls, inst };
}
const video = (can: string) => {
  const v = document.createElement('video');
  v.canPlayType = () => can as CanPlayTypeResult;
  v.load = () => {};
  return v;
};

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE = `${CHROME} Edg/141.0.0.0`;
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PLAYLIST = '/api/sessions/s/c/index.m3u8';
const DIRECT = '/api/sessions/s/c/direct';

test('desktop Chrome uses hls.js even when it claims native HLS', () => {
  const { Hls, inst } = fakeHls(true);
  const v = video('maybe');
  attachStream(v, PLAYLIST, { Hls, ua: CHROME });
  expect(Hls).toHaveBeenCalledTimes(1);
  expect(inst.loadSource).toHaveBeenCalledWith(PLAYLIST);
  expect(inst.attachMedia).toHaveBeenCalledWith(v);
  expect(v.getAttribute('src')).toBeNull();
});

test('iPhone Safari uses native HLS', () => {
  const { Hls } = fakeHls(true);
  const v = video('maybe');
  attachStream(v, PLAYLIST, { Hls, ua: IPHONE });
  expect(v.getAttribute('src')).toBe(PLAYLIST);
  expect(Hls).not.toHaveBeenCalled();
});

test.each([
  ['iPhone', IPHONE, 'maybe', 0, true],
  ['desktop Safari', MAC_SAFARI, 'maybe', 0, true],
  ['iPad asking for the desktop site', MAC_SAFARI, 'maybe', 5, true],
  ['Safari that cannot play HLS', MAC_SAFARI, '', 0, false],
  ['desktop Chrome', CHROME, 'maybe', 0, false],
  ['Edge', EDGE, 'maybe', 0, false],
  ['Android Chrome', ANDROID, 'probably', 5, false],
])('prefersNativeHls: %s', (_name, ua, can, maxTouchPoints, expected) => {
  const v = video(can);
  Object.defineProperty(v.ownerDocument.defaultView!.navigator, 'maxTouchPoints', { configurable: true, get: () => maxTouchPoints });
  try {
    expect(prefersNativeHls(ua, v)).toBe(expected);
  } finally {
    Reflect.deleteProperty(v.ownerDocument.defaultView!.navigator, 'maxTouchPoints');
  }
});

test('attachStream falls back to hls.js', () => {
  const { Hls, inst } = fakeHls(true);
  const v = video('');
  const handle = attachStream(v, PLAYLIST, { Hls });
  expect(inst.loadSource).toHaveBeenCalledWith(PLAYLIST);
  expect(inst.attachMedia).toHaveBeenCalledWith(v);
  handle.destroy();
  expect(inst.destroy).toHaveBeenCalled();
});

test('VOD hls.js starts at 0', () => {
  const vod = fakeHls(true);
  attachStream(video(''), PLAYLIST, { Hls: vod.Hls, vod: true, ua: CHROME });
  expect(vod.Hls).toHaveBeenCalledWith({ startPosition: 0 });

  const live = fakeHls(true);
  attachStream(video(''), PLAYLIST, { Hls: live.Hls, vod: false, ua: CHROME });
  expect(live.Hls.mock.calls[0]![0]).not.toHaveProperty('startPosition');
});

test('live hls.js reports an endless duration, so the player can tell how far behind live it is', () => {
  const live = fakeHls(true);
  attachStream(video(''), PLAYLIST, { Hls: live.Hls, vod: false, ua: CHROME });
  expect(live.Hls).toHaveBeenCalledWith({ liveDurationInfinity: true });

  const vod = fakeHls(true);
  attachStream(video(''), PLAYLIST, { Hls: vod.Hls, vod: true, ua: CHROME });
  expect(vod.Hls.mock.calls[0]![0]).not.toHaveProperty('liveDurationInfinity');
});

test('direct URLs are always set as src', () => {
  const { Hls } = fakeHls(true);
  const v = video('');
  attachStream(v, DIRECT, { Hls });
  expect(v.getAttribute('src')).toBe(DIRECT);
  expect(Hls).not.toHaveBeenCalled();
});

test('destroy clears the src', () => {
  const v = video('maybe');
  const h = attachStream(v, DIRECT);
  h.destroy();
  expect(v.getAttribute('src')).toBeNull();
});

/** A text track list as the element reports it: indexed, with a length, firing addtrack. */
function textTracks(v: HTMLVideoElement, kinds: TextTrackKind[]) {
  const list = Object.assign(new EventTarget(), { length: 0 }) as EventTarget & { length: number; [i: number]: { kind: string; mode: string } };
  const add = (kind: TextTrackKind) => {
    const track = { kind, mode: 'disabled' };
    list[list.length++] = track;
    list.dispatchEvent(new Event('addtrack'));
    return track;
  };
  const tracks = kinds.map(add);
  Object.defineProperty(v, 'textTracks', { get: () => list });
  return { tracks, add };
}

test('showSubtitles toggles native text tracks', () => {
  const v = video('maybe');
  const { tracks, add } = textTracks(v, ['subtitles', 'captions', 'metadata']);
  const handle = attachStream(v, PLAYLIST, { Hls: fakeHls(true).Hls, ua: IPHONE });
  handle.showSubtitles(true);
  expect(tracks.map((t) => t.mode)).toEqual(['showing', 'showing', 'disabled']);
  handle.showSubtitles(false);
  expect(tracks.map((t) => t.mode)).toEqual(['disabled', 'disabled', 'disabled']);

  // Safari lists the session's subtitle rendition only once it has read the playlist.
  handle.showSubtitles(true);
  expect(add('subtitles').mode).toBe('showing');
  handle.destroy();
  expect(add('subtitles').mode).toBe('disabled');
});

test('hls.js showSubtitles picks the rendition once it is listed, and only shows or hides before then', () => {
  const { Hls, inst } = fakeHls(true);
  const handle = attachStream(video(''), PLAYLIST, { Hls, vod: true, ua: CHROME });
  // Asking hls.js for a track it hasn't listed yet fails, and stops it picking the default rendition.
  handle.showSubtitles(true);
  expect([inst.subtitleTrack, inst.subtitleDisplay]).toEqual([-1, true]);
  inst.subtitleTracks = [{ name: 'subtitle_0' }];
  handle.showSubtitles(false);
  expect([inst.subtitleTrack, inst.subtitleDisplay]).toEqual([-1, false]);
  handle.showSubtitles(true);
  expect([inst.subtitleTrack, inst.subtitleDisplay]).toEqual([0, true]);
});

/** Records every seek (currentTime assignment); `readyState` is what the element reports. */
function seekable(can: string, readyState = 0) {
  const v = video(can);
  const seeks: number[] = [];
  Object.defineProperty(v, 'currentTime', { get: () => seeks.at(-1) ?? 0, set: (t: number) => void seeks.push(t) });
  Object.defineProperty(v, 'readyState', { get: () => readyState });
  return { v, seeks };
}

test('a direct stream resumed at 600 seeks there once its metadata has loaded, and only once', () => {
  const { v, seeks } = seekable('');
  attachStream(v, DIRECT, { Hls: fakeHls(true).Hls, startAtSec: 600 });
  expect(seeks).toEqual([]);
  v.dispatchEvent(new Event('loadedmetadata'));
  expect(seeks).toEqual([600]);
  v.dispatchEvent(new Event('loadedmetadata'));
  expect(seeks).toEqual([600]);
});

test('a direct stream whose metadata is already there seeks at once', () => {
  const { v, seeks } = seekable('', 1);
  attachStream(v, DIRECT, { startAtSec: 600 });
  expect(seeks).toEqual([600]);
});

test('destroying a direct stream before its metadata loads cancels the seek', () => {
  const { v, seeks } = seekable('');
  attachStream(v, DIRECT, { startAtSec: 600 }).destroy();
  v.dispatchEvent(new Event('loadedmetadata'));
  expect(seeks).toEqual([]);
});

test('HLS streams never seek: the session already starts at the offset', () => {
  const native = seekable('maybe', 1);
  attachStream(native.v, PLAYLIST, { Hls: fakeHls(true).Hls, startAtSec: 600, ua: IPHONE });
  native.v.dispatchEvent(new Event('loadedmetadata'));

  const hlsJs = seekable('', 1);
  attachStream(hlsJs.v, PLAYLIST, { Hls: fakeHls(true).Hls, startAtSec: 600 });
  hlsJs.v.dispatchEvent(new Event('loadedmetadata'));

  const fallback = seekable('', 1);
  attachStream(fallback.v, PLAYLIST, { startAtSec: 600 });
  fallback.v.dispatchEvent(new Event('loadedmetadata'));

  expect([native.seeks, hlsJs.seeks, fallback.seeks]).toEqual([[], [], []]);
});
