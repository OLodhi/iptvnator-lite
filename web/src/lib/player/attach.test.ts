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
