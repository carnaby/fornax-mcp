import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the protocol sources; no build step needed.
    alias: { '@fornax/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    env: { LOG_LEVEL: 'warn' },
  },
});
