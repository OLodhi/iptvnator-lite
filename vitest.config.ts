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
