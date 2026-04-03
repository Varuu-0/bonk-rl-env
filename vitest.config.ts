import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/perf/**/*.test.ts',
      'tests/security/**/*.test.ts',
      'tests/property/**/*.test.ts',
    ],
    exclude: [
      'tests/e2e/**/*.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'threads',
    isolate: true,
    maxThreads: 4,
    server: {
      deps: {
        inline: ['box2d'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/index.d.ts',
        'src/core/worker-loader.js',
        'src/main.ts',
        'src/server.ts',
      ],
      thresholds: {
        lines: 50,
        branches: 40,
        functions: 45,
        statements: 50,
      },
      reportsDirectory: 'coverage',
    },
  },
});
