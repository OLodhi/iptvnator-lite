import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../config.ts';

export function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-test-'));
  const base = loadConfig({
    TV_DATA_DIR: path.join(dir, 'data'),
    TV_TRANSCODE_DIR: path.join(dir, 'transcode'),
    TV_WEB_DIR: path.join(dir, 'web'),
    TV_FFMPEG_PATH: process.env.TV_FFMPEG_PATH,
    TV_FFPROBE_PATH: process.env.TV_FFPROBE_PATH,
  });
  return { ...base, ...overrides };
}
