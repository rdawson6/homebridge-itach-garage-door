import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live in *.test.ts, property-based tests in *.prop.ts
    include: ['test/**/*.test.ts', 'test/**/*.prop.ts'],
    environment: 'node',
    globals: false,
    // Property-based suites run >=100 iterations each, so allow generous timeouts
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
