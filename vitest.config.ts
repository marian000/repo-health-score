import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Module fixtures build real git repositories one `git commit` subprocess
    // at a time; twenty of them comfortably exceed the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // types.ts is not excluded: it carries runtime helpers (clampScore,
      // scored, notApplicable) that every module's output passes through.
      exclude: ['src/**/*.test.ts'],
    },
  },
});
