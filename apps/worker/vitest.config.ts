import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources of the other packages; no build step needed.
    alias: {
      '@fornax/protocol': source('../../packages/protocol/src/index.ts'),
      '@fornax/server/testing': source('../server/src/testing.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    env: { LOG_LEVEL: 'warn' },
  },
});
