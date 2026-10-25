import { expect, test, vi } from 'vitest';
import type { PlayResponse } from '@tv/shared';
import { createPlayback } from './playback.ts';

const res = (id: string, durationSec: number | null = null): PlayResponse => ({
  sessionId: id,
  mode: 'hls',
  url: `/api/sessions/${id}/cid/index.m3u8`,
  durationSec,
  startAtSec: 0,
  tracks: null,
});

function setup() {
  const pending: { resolve: (r: PlayResponse) => void; reject: (e: unknown) => void; signal: AbortSignal }[] = [];
  const play = vi.fn(
    (_req: unknown, signal: AbortSignal) =>
      new Promise<PlayResponse>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      }),
  );
  const stopHb = vi.fn();
  const destroy = vi.fn();
  const deps = {
    play,
    releaseSession: vi.fn(async (_s: string, _c: string) => {}),
    startHeartbeat: vi.fn((_s: string, _c: string, _o: { onGone: () => void }) => stopHb),
    attachStream: vi.fn((_v: HTMLVideoElement, _u: string, _o: { startAtSec?: number }) => ({ destroy })),
    clientId: () => 'cid',
    onGone: vi.fn(),
    onError: vi.fn(),
  };
  const video = document.createElement('video');
  return { pb: createPlayback(deps), deps, pending, video, stopHb, destroy };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const params = { itemId: 1, startAtSec: 0 };

test('start forwards catchup into the play request', async () => {
  const { pb, deps, pending, video } = setup();
  const p = pb.start({ itemId: 1, startAtSec: 0, catchup: { startSec: 1000, stopSec: 4600 } }, video);
  expect(deps.play.mock.calls[0]![0]).toEqual({ itemId: 1, startAtSec: 0, clientId: 'cid', catchup: { startSec: 1000, stopSec: 4600 } });
  pending[0]!.resolve(res('s1', 3600));
  await p;
});

test('normal path attaches, heartbeats, and releases once on teardown', async () => {
  const { pb, deps, pending, video, stopHb, destroy } = setup();
  const p = pb.start(params, video);
  expect(deps.play.mock.calls[0]![0]).toEqual({ itemId: 1, startAtSec: 0, clientId: 'cid' });
  pending[0]!.resolve(res('s1'));
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/index.m3u8', {});
  expect(deps.startHeartbeat).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).not.toHaveBeenCalled();
  pb.teardown();
  pb.teardown();
  expect(stopHb).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).toHaveBeenCalledWith('s1', 'cid');
});

test('teardown during an in-flight play aborts it and releases the late session once', async () => {
  const { pb, deps, pending, video } = setup();
  const p = pb.start(params, video);
  pb.teardown();
  expect(pending[0]!.signal.aborted).toBe(true);
  pending[0]!.resolve(res('late'));
  await p;
  await flush();
  expect(deps.releaseSession).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).toHaveBeenCalledWith('late', 'cid');
  expect(deps.attachStream).not.toHaveBeenCalled();
  expect(deps.startHeartbeat).not.toHaveBeenCalled();
  expect(deps.onError).not.toHaveBeenCalled();
});

test('an aborted play that rejects is not reported as an error', async () => {
  const { pb, deps, pending, video } = setup();
  const p = pb.start(params, video);
  pb.teardown();
  pending[0]!.reject(new DOMException('aborted', 'AbortError'));
  await p;
  expect(deps.onError).not.toHaveBeenCalled();
  expect(deps.releaseSession).not.toHaveBeenCalled();
});

test('overlapping starts: first session released, only the second attaches', async () => {
  const { pb, deps, pending, video } = setup();
  const p1 = pb.start(params, video);
  const p2 = pb.start(params, video);
  pending[1]!.resolve(res('second'));
  await p2;
  pending[0]!.resolve(res('first'));
  await p1;
  expect(deps.releaseSession).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).toHaveBeenCalledWith('first', 'cid');
  expect(deps.attachStream).toHaveBeenCalledTimes(1);
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/second/cid/index.m3u8', {});
  expect(deps.startHeartbeat).toHaveBeenCalledTimes(1);
  pb.teardown();
  expect(deps.releaseSession).toHaveBeenCalledWith('second', 'cid');
});

test('starting again after a live session releases the old one', async () => {
  const { pb, deps, pending, video } = setup();
  const p1 = pb.start(params, video);
  pending[0]!.resolve(res('one'));
  await p1;
  const p2 = pb.start(params, video);
  expect(deps.releaseSession).toHaveBeenCalledWith('one', 'cid');
  pending[1]!.resolve(res('two'));
  await p2;
  expect(deps.attachStream).toHaveBeenCalledTimes(2);
});

test('a real failure is reported, and a heartbeat 404 reports gone', async () => {
  const { pb, deps, pending, video } = setup();
  const p = pb.start(params, video);
  pending[0]!.reject(new Error('boom'));
  await p;
  expect(deps.onError).toHaveBeenCalledTimes(1);

  const p2 = pb.start(params, video);
  pending[1]!.resolve(res('s2', 120));
  await p2;
  expect(pb.isVod()).toBe(true);
  deps.startHeartbeat.mock.calls[0]![2].onGone();
  expect(deps.onGone).toHaveBeenCalledTimes(1);
});

test('absoluteSec adds the session start offset, so a restart after a resume stays at the real position', async () => {
  const { pb, pending, video } = setup();
  const p = pb.start({ itemId: 1, startAtSec: 610 }, video);
  pending[0]!.resolve({ ...res('s1', 3000), startAtSec: 610 });
  await p;
  video.currentTime = 10;
  expect(pb.absoluteSec(video)).toBe(620);
});

test('onStarted gets the server offset and duration; onStopping fires once, before the video is detached', async () => {
  const { deps, pending, video, destroy } = setup();
  const order: string[] = [];
  const onStarted = vi.fn();
  const onStopping = vi.fn(() => order.push(`stopping:${destroy.mock.calls.length}`));
  const pb = createPlayback({ ...deps, onStarted, onStopping });
  const p = pb.start({ itemId: 1, startAtSec: 90 }, video);
  pending[0]!.resolve({ ...res('s1', 3000), startAtSec: 88 });
  await p;
  expect(onStarted).toHaveBeenCalledWith({ offsetSec: 88, durationSec: 3000 });
  pb.teardown();
  pb.teardown();
  expect(onStopping).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['stopping:0']);
});

const direct = (id: string, startAtSec: number): PlayResponse => ({
  sessionId: id,
  mode: 'direct',
  url: `/api/sessions/${id}/cid/direct`,
  durationSec: 3000,
  startAtSec,
  tracks: null,
});

test('a direct resume seeks the file itself, and its currentTime is already absolute', async () => {
  const { deps, pending, video } = setup();
  const onStarted = vi.fn();
  const pb = createPlayback({ ...deps, onStarted });
  const p = pb.start({ itemId: 1, startAtSec: 600 }, video);
  pending[0]!.resolve(direct('s1', 600));
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/direct', { startAtSec: 600 });
  expect(onStarted).toHaveBeenCalledWith({ offsetSec: 0, durationSec: 3000 });
  video.currentTime = 610;
  expect(pb.absoluteSec(video)).toBe(610);
});

test('a direct start from the beginning asks for no seek', async () => {
  const { pb, deps, pending, video } = setup();
  const p = pb.start(params, video);
  pending[0]!.resolve(direct('s1', 0));
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/direct', {});
});

test('an HLS resume starts the stream at the offset: no seek, and currentTime counts from it', async () => {
  const { deps, pending, video } = setup();
  const onStarted = vi.fn();
  const pb = createPlayback({ ...deps, onStarted });
  const p = pb.start({ itemId: 1, startAtSec: 600 }, video);
  pending[0]!.resolve({ ...res('s1', 3000), startAtSec: 600 });
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/index.m3u8', {});
  expect(onStarted).toHaveBeenCalledWith({ offsetSec: 600, durationSec: 3000 });
  video.currentTime = 10;
  expect(pb.absoluteSec(video)).toBe(610);
});
