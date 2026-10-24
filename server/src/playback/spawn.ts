import { spawn } from 'node:child_process';
import { redactUrl } from '../util/redact.ts';
import type { ChildLike, SessionManagerDeps } from './sessions.ts';

/**
 * The session manager's `spawn`: FFmpeg with no shell, no stdin or stdout, and stderr piped for logging.
 *
 * A child that fails to start (e.g. ENOENT) emits 'error' and never 'exit'. Unhandled, that error would
 * crash the server; here it is logged and reported as one exit with a null code. An 'error' from a child
 * that did start (a failed kill) is only logged: its real 'exit' still follows.
 */
export function spawnFfmpeg(log: SessionManagerDeps['log']): SessionManagerDeps['spawn'] {
  return (cmd, args) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let exited = false;
    let exitCode: number | null = null;
    const listeners: ((code: number | null) => void)[] = [];
    const finish = (code: number | null) => {
      if (exited) return;
      exited = true;
      exitCode = code;
      for (const cb of listeners.splice(0)) cb(code);
    };
    child.once('exit', (code) => finish(code));
    child.on('error', (err: NodeJS.ErrnoException) => {
      // Only the message: the error object also carries spawnargs, which include the provider URL.
      log.warn({ pid: child.pid, code: err.code, err: redactUrl(err.message) }, 'ffmpeg process error');
      if (child.pid === undefined) finish(null);
    });

    const wrapped: ChildLike = {
      get pid() {
        return child.pid;
      },
      kill: () => child.kill(),
      once(_event, cb) {
        if (exited) queueMicrotask(() => cb(exitCode));
        else listeners.push(cb);
        return wrapped;
      },
      stderr: child.stderr,
    };
    return wrapped;
  };
}
