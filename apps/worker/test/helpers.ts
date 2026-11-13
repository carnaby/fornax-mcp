import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type Paths, resolvePaths } from '../src/paths.js';

/** Fresh temp directories, removed after each test (with retries: Windows may hold a file for a moment). */
export function useTempDir(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return () => {
    const d = mkdtempSync(join(tmpdir(), 'fornax-worker-'));
    dirs.push(d);
    return d;
  };
}

/** Worker directories inside a temp root, through the same overrides a user would set. */
export const testPaths = (root: string): Paths =>
  resolvePaths({ FORNAX_CONFIG_DIR: join(root, 'config'), FORNAX_DATA_DIR: join(root, 'data') });
