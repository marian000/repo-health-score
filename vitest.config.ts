import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // types.ts is not excluded: it carries runtime helpers (clampScore,
      // scored, notApplicable) that every module's output passes through.
      exclude: ['src/**/*.test.ts'],
    },
  },
});
