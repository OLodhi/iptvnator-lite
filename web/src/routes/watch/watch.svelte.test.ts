import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { PlayResponse } from '@tv/shared';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/watch?item=7&t=600') }));
const api = vi.hoisted(() => vi.fn());
const attachStream = vi.hoisted(() => vi.fn((_v: HTMLVideoElement, _url: string, _opts: object) => ({ destroy: () => {} })));
const heartbeats = vi.hoisted(() => [] as { onGone: () => void }[]);
vi.mock('$app/state', () => ({ page: route }));
vi.mock('hls.js', () => ({ default: {} }));
vi.mock('$lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('$lib/api')>()), api }));
vi.mock('$lib/me', () => ({ positions: vi.fn(async () => []), reportPosition: vi.fn(async () => {}) }));
vi.mock('$lib/session', () => ({
  releaseSession: vi.fn(async () => {}),
  startHeartbeat: vi.fn((_s: string, _c: string, opts: { onGone: () => void }) => {
    heartbeats.push(opts);
    return () => {};
  }),
}));
vi.mock('$lib/clientId', () => ({ getClientId: () => 'cid' }));
vi.mock('$lib/player/attach', () => ({ attachStream }));

import Watch from './+page.svelte';

let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  api.mockReset();
  attachStream.mockClear();
  heartbeats.length = 0;
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

const playCalls = () => api.mock.calls.filter(([path]) => path === '/api/play');
const startAtOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string).startAtSec as number;

/** Resumes at 0:10:00, watches until currentTime says `currentTime`, loses the session, then taps restart. */
async function resumeThenRestart(response: PlayResponse, currentTime: number) {
  api.mockImplementation(async (path: string) => (path === '/api/play' ? response : undefined));
  app = mount(Watch, { target: document.body });
  await vi.waitFor(() => expect(attachStream).toHaveBeenCalledTimes(1));
  const video = document.querySelector('video')!;
  video.currentTime = currentTime;
  heartbeats[0]!.onGone();
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Tap to restart'))!.click();
  await vi.waitFor(() => expect(playCalls()).toHaveLength(2));
}

test('a direct resume seeks the file, and a restart resumes at the absolute position', async () => {
  const direct: PlayResponse = { sessionId: 's1', mode: 'direct', url: '/api/sessions/s1/cid/direct', durationSec: 3000, startAtSec: 600 };
  await resumeThenRestart(direct, 610); // the file was seeked to 600, so currentTime is already absolute
  expect(attachStream.mock.calls[0]).toEqual([expect.any(HTMLVideoElement), direct.url, expect.objectContaining({ startAtSec: 600 })]);
  expect(playCalls().map(startAtOf)).toEqual([600, 610]);
});

test('an HLS resume asks for no seek, and a restart resumes at the absolute position', async () => {
  const hls: PlayResponse = { sessionId: 's1', mode: 'hls', url: '/api/sessions/s1/cid/index.m3u8', durationSec: 3000, startAtSec: 600 };
  await resumeThenRestart(hls, 10); // the session starts at 600, so currentTime counts from there
  expect(attachStream.mock.calls[0]![2]).not.toHaveProperty('startAtSec');
  expect(playCalls().map(startAtOf)).toEqual([600, 610]);
});
