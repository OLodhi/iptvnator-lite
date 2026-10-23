import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.TV_FFMPEG_PATH ?? 'ffmpeg';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'media');

const sources = (seconds: number) => [
  '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${seconds}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
  '-t', String(seconds),
];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '2M', '-g', '50', '-c:a', 'aac', '-b:a', '96k'];

type Job = { output: string; args: string[] };
const jobs: Job[] = [
  {
    output: 'hls/index.m3u8',
    args: [...sources(30), ...h264, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(mediaDir, 'hls', 'seg%03d.ts')],
  },
  { output: 'raw.ts', args: [...sources(30), ...h264, '-f', 'mpegts'] },
  {
    output: 'mpeg2.ts',
    args: [...sources(30), '-c:v', 'mpeg2video', '-b:v', '2M', '-g', '25', '-c:a', 'mp2', '-b:a', '128k', '-f', 'mpegts'],
  },
  { output: 'movie.mkv', args: [...sources(60), ...h264] },
  { output: 'movie.mp4', args: [...sources(60), ...h264, '-movflags', '+faststart'] },
  {
    output: 'hevc.mkv',
    args: [...sources(20), '-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error',
      '-c:a', 'aac', '-b:a', '96k'],
  },
];

mkdirSync(join(mediaDir, 'hls'), { recursive: true });
for (const job of jobs) {
  const out = join(mediaDir, ...job.output.split('/'));
  if (existsSync(out)) {
    console.log(`skip ${job.output} (exists)`);
    continue;
  }
  console.log(`make ${job.output}`);
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...job.args, out], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`ffmpeg failed for ${job.output}${r.error ? `: ${r.error.message}` : ''}. Set TV_FFMPEG_PATH to an ffmpeg binary.`);
    process.exit(1);
  }
}
console.log(`media ready in ${mediaDir}`);
