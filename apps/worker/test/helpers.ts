import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { stringify as toYaml } from 'yaml';
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

/** Write <packDir>/type.yaml from a plain object. */
export function writeTypeYaml(packDir: string, doc: Record<string, unknown>): void {
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'type.yaml'), toYaml(doc));
}

export const FAKE_TOOL = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));

/** Whether a process with this pid still exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll until `fn` gives a truthy value; fail after `ms`. */
export async function waitFor<T>(fn: () => T | Promise<T>, ms = 10_000, what = 'a condition'): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The pids a "tree" or "hang" tool wrote, once the file is complete. */
export function readPids(file: string): { parent: number; child: number } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { parent: number; child: number };
  } catch {
    return null;
  }
}
