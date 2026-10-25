import { expect, test, vi } from 'vitest';
import type { PlayRequest, PlayResponse, SessionTracks } from '@tv/shared';
import { createPlayback, type StartParams } from './playback.ts';

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
    (_req: PlayRequest, signal: AbortSignal) =>
      new Promise<PlayResponse>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      }),
  );
  // jsdom has no real media: the test says when the stream is open and how much of it can be seeked.
  const el = { readyState: 0, seekableEnd: 0 };
  const video = document.createElement('video');
  Object.defineProperty(video, 'readyState', { get: () => el.readyState });
  Object.defineProperty(video, 'seekable', { get: () => ({ length: 1, start: () => 0, end: () => el.seekableEnd }) });
  const stopHb = vi.fn();
  const destroy = vi.fn(() => {
    el.readyState = 0; // removing the stream empties the element
  });
  const showSubtitles = vi.fn();
  const deps = {
    play,
    releaseSession: vi.fn(async (_s: string, _c: string) => {}),
    startHeartbeat: vi.fn((_s: string, _c: string, _o: { onGone: () => void }) => stopHb),
    attachStream: vi.fn((_v: HTMLVideoElement, _u: string, _o: { startAtSec?: number; vod?: boolean }) => ({ destroy, showSubtitles })),
    clientId: () => 'cid',
    onGone: vi.fn(),
    onError: vi.fn(),
  };
  /** The stream's metadata loads, with `seekableEnd` seconds of it seekable so far. */
  const open = (seekableEnd = 0) => {
    el.readyState = HTMLMediaElement.HAVE_METADATA;
    el.seekableEnd = seekableEnd;
    video.dispatchEvent(new Event('loadedmetadata'));
  };
  return { pb: createPlayback(deps), deps, pending, video, stopHb, destroy, showSubtitles, open };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const params: StartParams = { kind: 'movie', itemId: 1, startAtSec: 0 };
const playBody = (deps: ReturnType<typeof setup>['deps'], n: number) => deps.play.mock.calls[n]![0];

test('start forwards catchup into the play request', async () => {
  const { pb, deps, pending, video } = setup();
  const p = pb.start({ kind: 'catchup', itemId: 1, startAtSec: 0, catchup: { startSec: 1000, stopSec: 4600 } }, video);
  expect(playBody(deps, 0)).toEqual({ itemId: 1, startAtSec: 0, clientId: 'cid', catchup: { startSec: 1000, stopSec: 4600 } });
  pending[0]!.resolve(res('s1', 3600));
  await p;
});

test('normal path attaches, heartbeats, and releases once on teardown', async () => {
  const { pb, deps, pending, video, stopHb, destroy } = setup();
  const p = pb.start(params, video);
  expect(playBody(deps, 0)).toEqual({ itemId: 1, startAtSec: 0, clientId: 'cid' });
  pending[0]!.resolve(res('s1'));
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/index.m3u8', { vod: true });
  expect(deps.startHeartbeat).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).not.toHaveBeenCalled();
  pb.teardown();
  pb.teardown();
  expect(stopHb).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).toHaveBeenCalledWith('s1', 'cid');
  expect(pb.current()).toBeNull();
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
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/second/cid/index.m3u8', { vod: true });
  expect(deps.startHeartbeat).toHaveBeenCalledTimes(1);
  pb.teardown();
  expect(deps.releaseSession).toHaveBeenCalledWith('second', 'cid');
});

test('starting again after a live session releases the old one', async () => {
  const { pb, deps, pending, video } = setup();
  const p1 = pb.start({ kind: 'live', itemId: 1, startAtSec: 0 }, video);
  pending[0]!.resolve(res('one'));
  await p1;
  const p2 = pb.start({ kind: 'live', itemId: 2, startAtSec: 0 }, video);
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

test('catch-up and VOD without a duration are VOD', async () => {
  const { pb, deps, pending, video } = setup();
  const kinds: StartParams[] = [
    { kind: 'catchup', itemId: 1, startAtSec: 0, catchup: { startSec: 1000, stopSec: 4600 } },
    { kind: 'movie', itemId: 2, startAtSec: 0 },
    { kind: 'episode', itemId: 3, episodeRemoteId: '111', startAtSec: 0 },
    { kind: 'live', itemId: 4, startAtSec: 0 },
  ];
  const vod: boolean[] = [];
  for (const [i, p] of kinds.entries()) {
    const started = pb.start(p, video);
    pending[i]!.resolve(res(`s${i}`, null));
    await started;
    vod.push(pb.isVod());
  }
  expect(vod).toEqual([true, true, true, false]);
  expect(deps.attachStream.mock.calls.map((c) => c[2].vod)).toEqual([true, true, true, false]);
});

test('absoluteSec adds the session start offset, so a restart after a resume stays at the real position', async () => {
  const { pb, pending, video, open } = setup();
  const p = pb.start({ kind: 'movie', itemId: 1, startAtSec: 610 }, video);
  pending[0]!.resolve({ ...res('s1', 3000), startAtSec: 610 });
  await p;
  open();
  video.currentTime = 10;
  expect(pb.absoluteSec(video)).toBe(620);
});

test('absoluteSec before metadata returns the pending start', async () => {
  const { pb, pending, video, open } = setup();
  const p = pb.start({ kind: 'movie', itemId: 1, startAtSec: 600 }, video);
  expect(pb.absoluteSec(video)).toBe(600); // the play request is still in flight
  pending[0]!.resolve(direct('s1', 600));
  await p;
  expect(pb.absoluteSec(video)).toBe(600); // attached, but the file isn't open or seeked yet: currentTime still says 0
  open();
  video.currentTime = 612;
  expect(pb.absoluteSec(video)).toBe(612);
});

test('onStarted gets the session; onStopping fires once, before the video is detached', async () => {
  const { deps, pending, video, destroy, showSubtitles } = setup();
  const order: string[] = [];
  const onStarted = vi.fn();
  const onStopping = vi.fn(() => order.push(`stopping:${destroy.mock.calls.length}`));
  const pb = createPlayback({ ...deps, onStarted, onStopping });
  const p = pb.start({ kind: 'movie', itemId: 1, startAtSec: 90 }, video);
  pending[0]!.resolve({ ...res('s1', 3000), startAtSec: 88 });
  await p;
  expect(onStarted).toHaveBeenCalledWith({ offsetSec: 88, durationSec: 3000, mode: 'hls', tracks: null, handle: { destroy, showSubtitles } });
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
  const { deps, pending, video, open } = setup();
  const onStarted = vi.fn();
  const pb = createPlayback({ ...deps, onStarted });
  const p = pb.start({ kind: 'movie', itemId: 1, startAtSec: 600 }, video);
  pending[0]!.resolve(direct('s1', 600));
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/direct', { vod: true, startAtSec: 600 });
  expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ offsetSec: 0, durationSec: 3000, mode: 'direct' }));
  open();
  video.currentTime = 610;
  expect(pb.absoluteSec(video)).toBe(610);
});

test('a direct start from the beginning asks for no seek', async () => {
  const { pb, deps, pending, video } = setup();
  const p = pb.start(params, video);
  pending[0]!.resolve(direct('s1', 0));
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/direct', { vod: true });
});

test('an HLS resume starts the stream at the offset: no seek, and currentTime counts from it', async () => {
  const { deps, pending, video, open } = setup();
  const onStarted = vi.fn();
  const pb = createPlayback({ ...deps, onStarted });
  const p = pb.start({ kind: 'movie', itemId: 1, startAtSec: 600 }, video);
  pending[0]!.resolve({ ...res('s1', 3000), startAtSec: 600 });
  await p;
  expect(deps.attachStream).toHaveBeenCalledWith(video, '/api/sessions/s1/cid/index.m3u8', { vod: true });
  expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ offsetSec: 600, durationSec: 3000 }));
  open();
  video.currentTime = 10;
  expect(pb.absoluteSec(video)).toBe(610);
});

test('seekTo inside the loaded range only moves currentTime', async () => {
  const { pb, deps, pending, video, open } = setup();
  const p = pb.start({ kind: 'movie', itemId: 1, startAtSec: 600 }, video);
  pending[0]!.resolve({ ...res('s1', 3000), startAtSec: 600 });
  await p;
  open(300); // 600..900 has been remuxed so far
  await pb.seekTo(video, 750);
  expect(video.currentTime).toBe(150);
  await pb.seekTo(video, 900);
  expect(video.currentTime).toBe(300);
  await pb.seekTo(video, 600);
  expect(video.currentTime).toBe(0);
  expect(deps.play).toHaveBeenCalledTimes(1);
  expect(deps.releaseSession).not.toHaveBeenCalled();
});

test('seekTo beyond the remuxed range restarts the movie at the target', async () => {
  const { pb, deps, pending, video, open } = setup();
  const p = pb.start({ kind: 'movie', itemId: 1, startAtSec: 0 }, video);
  pending[0]!.resolve(res('s1', 3000));
  await p;
  open(120);
  const seek = pb.seekTo(video, 1800);
  expect(playBody(deps, 1)).toEqual({ itemId: 1, startAtSec: 1800, clientId: 'cid' });
  expect(deps.releaseSession).toHaveBeenCalledWith('s1', 'cid');
  pending[1]!.resolve({ ...res('s2', 3000), startAtSec: 1800 });
  await seek;
  expect(deps.attachStream).toHaveBeenCalledTimes(2);
  expect(pb.current()).toMatchObject({ offsetSec: 1800, durationSec: 3000, params: { startAtSec: 1800 } });

  // Back before where the new session starts: that hasn't been remuxed either.
  open(120);
  const back = pb.seekTo(video, 60);
  expect(playBody(deps, 2)).toMatchObject({ startAtSec: 60 });
  pending[2]!.resolve({ ...res('s3', 3000), startAtSec: 60 });
  await back;
  expect(deps.releaseSession.mock.calls.map(([s]) => s)).toEqual(['s1', 's2']);
});

test('seekTo clamps past the end to duration − 5 and before 0 to 0', async () => {
  const { pb, deps, pending, video, open } = setup();
  const p = pb.start({ kind: 'episode', itemId: 1, episodeRemoteId: '111', startAtSec: 0 }, video);
  pending[0]!.resolve(res('s1', 3000));
  await p;
  open(3000); // fully remuxed
  await pb.seekTo(video, 5000);
  expect(video.currentTime).toBe(2995);
  await pb.seekTo(video, -20);
  expect(video.currentTime).toBe(0);

  // Not remuxed that far yet: the restart lands at the clamp too, and so does a second skip while it is starting.
  open(120);
  void pb.seekTo(video, 3010);
  expect(playBody(deps, 1)).toMatchObject({ startAtSec: 2995 });
  void pb.seekTo(video, pb.absoluteSec(video) + 10);
  expect(playBody(deps, 2)).toMatchObject({ startAtSec: 2995 });
  pending[2]!.resolve({ ...res('s3', 3000), startAtSec: 2995 });
  await flush();

  // That session starts at 2995, so a seek to before 0 restarts it at 0.
  open(60);
  const back = pb.seekTo(video, -20);
  expect(playBody(deps, 3)).toMatchObject({ startAtSec: 0 });
  pending[3]!.resolve(res('s4', 3000));
  await back;
});

test('catch-up seek restarts at the minute and lands within a minute', async () => {
  const { deps, pending, video, open } = setup();
  const onStarted = vi.fn();
  const pb = createPlayback({ ...deps, onStarted });
  const programme = { startSec: 1000, stopSec: 4600 };
  const p = pb.start({ kind: 'catchup', itemId: 7, startAtSec: 0, catchup: programme }, video);
  pending[0]!.resolve(res('c1', 3600));
  await p;
  open(300);

  const seek = pb.seekTo(video, 754);
  expect(playBody(deps, 1)).toEqual({ itemId: 7, startAtSec: 0, clientId: 'cid', catchup: { startSec: 1720, stopSec: 4600 } });
  expect(deps.releaseSession).toHaveBeenCalledWith('c1', 'cid');
  pending[1]!.resolve(res('c2', 2880)); // the server's duration is the shorter window's
  await seek;
  expect(onStarted).toHaveBeenLastCalledWith(expect.objectContaining({ offsetSec: 720, durationSec: 3600 }));
  expect(pb.absoluteSec(video)).toBe(754); // not open yet
  open(60);
  expect(video.currentTime).toBe(34);
  expect(pb.absoluteSec(video)).toBe(754);
  expect(pb.current()).toMatchObject({ offsetSec: 720, durationSec: 3600, params: { catchup: programme, startAtSec: 754 } });

  // Within the new window it only seeks; before it, the window starts at the programme's own start again.
  await pb.seekTo(video, 760);
  expect(video.currentTime).toBe(40);
  const back = pb.seekTo(video, 30);
  expect(playBody(deps, 2)).toMatchObject({ catchup: programme, startAtSec: 0 });
  pending[2]!.resolve(res('c3', 3600));
  await back;
  open(60);
  expect(video.currentTime).toBe(30);
  expect(pb.absoluteSec(video)).toBe(30);
});

const tracks: SessionTracks = {
  audio: [
    { index: 1, label: 'English', language: 'en', isDefault: true, forced: false, available: true },
    { index: 2, label: 'Dutch', language: 'nl', isDefault: false, forced: false, available: true },
  ],
  subtitles: [{ index: 3, label: 'Dutch', language: 'nl', isDefault: false, forced: false, available: true }],
  audioIndex: 1,
  subtitleIndex: 3,
};

test('restartWith keeps the position and changes the tracks', async () => {
  const { deps, pending, video, open } = setup();
  const onStarted = vi.fn();
  const pb = createPlayback({ ...deps, onStarted });
  const p = pb.start({ kind: 'movie', itemId: 5, startAtSec: 0, subtitleLanguage: 'nl' }, video);
  expect(playBody(deps, 0)).toEqual({ itemId: 5, startAtSec: 0, clientId: 'cid', subtitleLanguage: 'nl' });
  pending[0]!.resolve({ ...res('s1', 3000), tracks });
  await p;
  expect(onStarted).toHaveBeenLastCalledWith(expect.objectContaining({ tracks }));
  expect(pb.current()?.tracks).toBe(tracks);
  open(400);
  video.currentTime = 125.6;

  const audio = pb.restartWith(video, { audioIndex: 2 });
  expect(playBody(deps, 1)).toEqual({ itemId: 5, startAtSec: 125, clientId: 'cid', audioIndex: 2, subtitleLanguage: 'nl' });
  expect(deps.releaseSession).toHaveBeenCalledWith('s1', 'cid');
  pending[1]!.resolve({ ...res('s2', 3000), startAtSec: 125, tracks: { ...tracks, audioIndex: 2 } });
  await audio;
  open(60);
  video.currentTime = 5;

  const off = pb.restartWith(video, { subtitleIndex: null });
  expect(playBody(deps, 2)).toEqual({ itemId: 5, startAtSec: 130, clientId: 'cid', audioIndex: 2, subtitleIndex: null, subtitleLanguage: 'nl' });
  pending[2]!.resolve({ ...res('s3', 3000), startAtSec: 130 });
  await off;
  expect(pb.current()?.params).toMatchObject({ audioIndex: 2, subtitleIndex: null, startAtSec: 130 });
});

test('a superseded restart is released, not attached', async () => {
  const { pb, deps, pending, video, open } = setup();
  const p = pb.start({ kind: 'episode', itemId: 11, episodeRemoteId: '111', startAtSec: 0 }, video);
  pending[0]!.resolve({ ...res('s1', 1500), tracks });
  await p;
  open(400);
  video.currentTime = 200;

  const first = pb.restartWith(video, { subtitleIndex: 3 });
  const second = pb.restartWith(video, { subtitleIndex: 4 }); // before the first has landed: still from 200
  expect(playBody(deps, 2)).toMatchObject({ startAtSec: 200, subtitleIndex: 4 });
  pending[2]!.resolve({ ...res('s3', 1500), startAtSec: 200 });
  await second;
  pending[1]!.resolve({ ...res('s2', 1500), startAtSec: 200 });
  await first;
  await flush();
  expect(deps.releaseSession.mock.calls.map(([s]) => s).sort()).toEqual(['s1', 's2']);
  expect(deps.attachStream.mock.calls.map(([, url]) => url)).toEqual(['/api/sessions/s1/cid/index.m3u8', '/api/sessions/s3/cid/index.m3u8']);
  expect(deps.startHeartbeat).toHaveBeenCalledTimes(2);
  expect(pb.current()?.params).toMatchObject({ subtitleIndex: 4 });
});
