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
    // Native modules (zeromq, box2d) crash with an access violation during
    // worker-thread teardown, which prevented full-suite runs from ever
    // completing. Forks isolate native handles per process.
    pool: 'forks',
    isolate: true,
    maxForks: 4,
    // Expose `global.gc` to test forks so heap assertions in tests/perf/
    // measure actual retained growth after a forced GC instead of GC timing.
    execArgv: ['--expose-gc'],
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
