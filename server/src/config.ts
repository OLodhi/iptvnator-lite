import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  transcodeDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  webDir: string;
  defaultUserAgent: string;
  transcodeInterlaced: boolean;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: Number(env.TV_PORT ?? 8686),
    host: env.TV_HOST ?? '0.0.0.0',
    dataDir: env.TV_DATA_DIR ?? './data',
    transcodeDir: env.TV_TRANSCODE_DIR ?? path.join(os.tmpdir(), 'tv-sessions'),
    ffmpegPath: env.TV_FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: env.TV_FFPROBE_PATH ?? 'ffprobe',
    webDir: env.TV_WEB_DIR ?? path.join(repoRoot, 'web', 'build'),
    defaultUserAgent: 'TiviMate/4.7.0',
    transcodeInterlaced: env.TV_TRANSCODE_INTERLACED === '1',
  };
}
