import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ChildLike } from './sessions.ts';
import { spawnFfmpeg } from './spawn.ts';

function collectingLog() {
  const lines: string[] = [];
  const push = (o: object, m: string) => void lines.push(JSON.stringify({ m, ...o }));
  return { lines, log: { info: push, warn: push } };
}

const exitOf = (child: ChildLike) => new Promise<number | null>((ok) => child.once('exit', ok));

test('a binary that cannot be started reports one null exit instead of crashing, and logs no URL', async () => {
  const { lines, log } = collectingLog();
  const child = spawnFfmpeg(log)(join(tmpdir(), 'no-such-ffmpeg.exe'), ['-i', 'http://provider.test/live/user/secret/1.ts']);
  expect(child.pid).toBeUndefined();
  expect(await exitOf(child)).toBeNull();
  expect(await exitOf(child)).toBeNull(); // a listener added afterwards still hears about it
  await vi.waitFor(() => expect(lines.join('\n')).toContain('ENOENT'));
  expect(lines.join('\n')).not.toMatch(/secret|provider\.test/);
});

test('a running child reports its exit code, pipes stderr, and can be killed', async () => {
  const { log } = collectingLog();
  const run = spawnFfmpeg(log);

  const done = run(process.execPath, ['-e', 'process.stderr.write("oops"); process.exit(3)']);
  expect(done.pid).toBeTypeOf('number');
  const stderr: Buffer[] = [];
  done.stderr!.on('data', (c: Buffer) => stderr.push(c));
  expect(await exitOf(done)).toBe(3);
  await vi.waitFor(() => expect(Buffer.concat(stderr).toString()).toBe('oops'));

  const slow = run(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
  expect(slow.kill()).toBe(true);
  await exitOf(slow); // resolves only once the process is gone
});
