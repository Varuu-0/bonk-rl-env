import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Native modules (zeromq, box2d) crash with an access violation during
    // worker-thread teardown, so isolate e2e runs per process the same way
    // the default suite does.
    pool: 'forks',
    isolate: true,
    maxForks: 4,
    server: {
      deps: {
        inline: ['box2d'],
      },
    },
  },
});