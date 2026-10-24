import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          root: 'server',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: ['**/*.scale.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'server-scale',
          root: 'server',
          environment: 'node',
          include: ['**/*.scale.test.ts'],
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'tools/fake-xtream',
          root: 'tools/fake-xtream',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
      {
        plugins: [svelte({ hot: false })],
        resolve: {
          conditions: ['browser'],
          alias: {
            $lib: fileURLToPath(new URL('./web/src/lib', import.meta.url)),
            '$app/state': fileURLToPath(new URL('./web/src/lib/testing/appState.ts', import.meta.url)),
          },
        },
        test: {
          name: 'web',
          root: 'web',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
});
