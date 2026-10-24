import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from './config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const startCwd = process.cwd();

afterEach(() => {
  process.chdir(startCwd);
});

// `npm start` runs in server/, `node server/src/main.ts` in the repo root: both must open the same database.
test('the default data dir is <repo>/data whatever the working directory, like the web dir', () => {
  for (const cwd of [repoRoot, path.join(repoRoot, 'server')]) {
    process.chdir(cwd);
    const config = loadConfig({});
    expect(config.dataDir, cwd).toBe(path.join(repoRoot, 'data'));
    expect(config.webDir, cwd).toBe(path.join(repoRoot, 'web', 'build'));
  }
});

test('an explicit TV_DATA_DIR is used as given', () => {
  const dir = path.join(repoRoot, 'somewhere', 'else');
  expect(loadConfig({ TV_DATA_DIR: dir }).dataDir).toBe(dir);
});
