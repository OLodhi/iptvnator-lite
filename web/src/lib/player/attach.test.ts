import { expect, test, vi } from 'vitest';
import { attachStream } from './attach.ts';

function fakeHls(supported: boolean) {
  const inst = { loadSource: vi.fn(), attachMedia: vi.fn(), destroy: vi.fn(), on: vi.fn(), startLoad: vi.fn(), recoverMediaError: vi.fn() };
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

test('attachStream uses native HLS when the browser can play it', () => {
  const { Hls } = fakeHls(true);
  const v = video('maybe');
  const url = '/api/sessions/s/c/index.m3u8';
  attachStream(v, url, { Hls });
  expect(v.getAttribute('src')).toBe(url);
  expect(Hls).not.toHaveBeenCalled();
});

test('attachStream falls back to hls.js', () => {
  const { Hls, inst } = fakeHls(true);
  const v = video('');
  const url = '/api/sessions/s/c/index.m3u8';
  const handle = attachStream(v, url, { Hls });
  expect(inst.loadSource).toHaveBeenCalledWith(url);
  expect(inst.attachMedia).toHaveBeenCalledWith(v);
  handle.destroy();
  expect(inst.destroy).toHaveBeenCalled();
});

test('direct URLs are always set as src', () => {
  const { Hls } = fakeHls(true);
  const v = video('');
  const url = '/api/sessions/s/c/direct';
  attachStream(v, url, { Hls });
  expect(v.getAttribute('src')).toBe(url);
  expect(Hls).not.toHaveBeenCalled();
});

test('destroy clears the src', () => {
  const v = video('maybe');
  const h = attachStream(v, '/api/sessions/s/c/direct');
  h.destroy();
  expect(v.getAttribute('src')).toBeNull();
});

/** Records every seek (currentTime assignment); `readyState` is what the element reports. */
function seekable(can: string, readyState = 0) {
  const v = video(can);
  const seeks: number[] = [];
  Object.defineProperty(v, 'currentTime', { get: () => seeks.at(-1) ?? 0, set: (t: number) => void seeks.push(t) });
  Object.defineProperty(v, 'readyState', { get: () => readyState });
  return { v, seeks };
}
const DIRECT = '/api/sessions/s/c/direct';
const PLAYLIST = '/api/sessions/s/c/index.m3u8';

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
  attachStream(native.v, PLAYLIST, { Hls: fakeHls(true).Hls, startAtSec: 600 });
  native.v.dispatchEvent(new Event('loadedmetadata'));

  const hlsJs = seekable('', 1);
  attachStream(hlsJs.v, PLAYLIST, { Hls: fakeHls(true).Hls, startAtSec: 600 });
  hlsJs.v.dispatchEvent(new Event('loadedmetadata'));

  const fallback = seekable('', 1);
  attachStream(fallback.v, PLAYLIST, { startAtSec: 600 });
  fallback.v.dispatchEvent(new Event('loadedmetadata'));

  expect([native.seeks, hlsJs.seeks, fallback.seeks]).toEqual([[], [], []]);
});
