import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeScript = path.resolve(here, '../../../tools/fake-xtream/src/server.ts');
const mediaDir = path.resolve(here, '../../../tools/fake-xtream/media');

/**
 * Starts the fake provider serving a generated catalogue (`<live>,<movie>,<series>,<categoriesPerKind>`) in its
 * own process, so its catalogue and JSON serialisation stay out of the test's RSS. `guide`
 * (`<channels>,<archivePercent>,<pastDays>,<futureDays>,<programmeMinutes>`) gives the first live items a guide.
 */
export async function startGeneratedFake(counts: string, opts: { guide?: string } = {}): Promise<{ url: string; stop(): void }> {
  const args = [fakeScript, '--port', '0', '--media', mediaDir, '--generate', counts];
  if (opts.guide) args.push('--guide', opts.guide);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /listening on (http:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]!);
    });
    child.once('exit', (code) => reject(new Error(`fake exited early (${code})`)));
  });
  return { url, stop: () => void child.kill() };
}
