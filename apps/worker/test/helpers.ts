import type { TestServer } from '@fornax/server/testing';
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


/** A client of a test server over real HTTP, as an app would use the REST API. */
export function clientOf(s: TestServer, token: string) {
  // JSON answers, typed loosely on purpose: tests check them with toMatchObject.
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${s.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    call,
    async upload(name: string, content: string): Promise<string> {
      const res = await fetch(`${s.url}/api/files?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: content,
      });
      if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { id: string }).id;
    },
    submit: (type: string, params: object, inputs: Record<string, string> = {}) => call('POST', '/api/jobs', { type, params, inputs }),
    job: (id: string) => call('GET', `/api/jobs/${id}`),
    cancel: (id: string) => call('POST', `/api/jobs/${id}/cancel`),
    async offered(): Promise<string[]> {
      return ((await call('GET', '/api/types')).types as { name: string }[]).map((t) => t.name);
    },
    async download(id: string, name: string): Promise<string> {
      const res = await fetch(`${s.url}/api/jobs/${id}/outputs/${name}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`download of ${name} failed: ${res.status}`);
      return res.text();
    },
  };
}
