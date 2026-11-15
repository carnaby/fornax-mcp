import { defineConfig } from 'vite';

// The tray's window. Port 1421 (Tabula's tray uses 1420), fixed because tauri.conf.json's devUrl names it.
export default defineConfig({
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
