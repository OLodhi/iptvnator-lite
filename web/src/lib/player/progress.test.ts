import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProgressReporter } from './progress.ts';

const video = (currentTime = 0) => ({ currentTime }) as HTMLVideoElement;
const base = { itemId: 7, episodeRemoteId: 'e1', offsetSec: 100, durationSec: 3000 };

function setup() {
  const report = vi.fn(async (_r: unknown) => {});
  const r = createProgressReporter({ report, now: () => Date.now() });
  return { r, report };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('reports offsetSec + currentTime every 15 s while playing', () => {
  const { r, report } = setup();
  const v = video(0);
  r.attach(v, base);
  v.currentTime = 10;
  vi.advanceTimersByTime(15_000);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenLastCalledWith({ itemId: 7, episodeRemoteId: 'e1', positionSec: 110, durationSec: 3000 });
  v.currentTime = 25;
  vi.advanceTimersByTime(15_000);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith({ itemId: 7, episodeRemoteId: 'e1', positionSec: 125, durationSec: 3000 });
  r.detach();
});

test('does not report before playback advances', async () => {
  const { r, report } = setup();
  // Paused at the resume point (iOS refused autoplay): currentTime stays 0 although offsetSec is large.
  r.attach(video(0), { ...base, offsetSec: 600 });
  vi.advanceTimersByTime(45_000);
  await r.flush();
  expect(report).not.toHaveBeenCalled();
  r.detach();

  // Advanced, but the absolute position is still under 5 s.
  r.attach(video(2), { ...base, offsetSec: 0 });
  vi.advanceTimersByTime(15_000);
  await r.flush();
  expect(report).not.toHaveBeenCalled();
  r.detach();
});

test('flush on leave sends the latest position once', async () => {
  const { r, report } = setup();
  const v = video(0);
  r.attach(v, { itemId: 7, offsetSec: 0, durationSec: null });
  v.currentTime = 42;
  await r.flush();
  await r.flush();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith({ itemId: 7, positionSec: 42, durationSec: null });
  r.detach();
});

test('with offsetSec 0 (a direct stream, already absolute) the report is currentTime unchanged', async () => {
  const { r, report } = setup();
  const v = video(0);
  r.attach(v, { ...base, offsetSec: 0 });
  v.currentTime = 610; // seeked to the resume point
  await r.flush();
  expect(report).toHaveBeenCalledWith({ itemId: 7, episodeRemoteId: 'e1', positionSec: 610, durationSec: 3000 });
  r.detach();
});

test('detach stops reporting', () => {
  const { r, report } = setup();
  r.attach(video(30), base);
  r.detach();
  vi.advanceTimersByTime(60_000);
  expect(report).not.toHaveBeenCalled();
});

test('a failing report never throws out of the timer or flush', async () => {
  const report = vi.fn(async () => {
    throw new Error('offline');
  });
  const r = createProgressReporter({ report, now: () => Date.now() });
  r.attach(video(30), base);
  vi.advanceTimersByTime(15_000);
  await expect(r.flush()).resolves.toBeUndefined();
  r.detach();
});
