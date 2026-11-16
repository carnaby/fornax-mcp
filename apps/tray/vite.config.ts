import { defineConfig } from 'vitest/config';

// The tray's window. Port 1421 (Tabula's tray uses 1420), fixed because tauri.conf.json's devUrl names it. The preview
// (pnpm preview, spec 06e § 4) serves preview/ on 1422; only index.html goes into the build.
export default defineConfig({
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  test: { include: ['src/**/*.test.ts'] },
});
