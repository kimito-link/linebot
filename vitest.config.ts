import { defineConfig } from 'vitest/config';

// Root vitest config — picks up tests under `scripts/` and `tools/`.
// Per-package tests (apps/worker, packages/*) keep their own configs.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['scripts/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
