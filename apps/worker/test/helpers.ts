import type { ClaimedJob } from '@fornax/protocol';
import type { TestServer } from '@fornax/server/testing';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { type Paths, resolvePaths } from '../src/paths.js';
import type { JobApi } from '../src/run-job.js';

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

export const JOB_TOOL = fileURLToPath(new URL('./fixtures/job-tool.mjs', import.meta.url));
/** worker.yaml tools for the echo pack: Node itself. */
export const NODE_TOOLS: Record<string, string> = { node: process.execPath };

/** The test type pack "echo" (or another name) in `typesDir`; its tool is fixtures/job-tool.mjs run by Node. */
export function writeEchoPack(typesDir: string, opts: { name?: string; maxRuntime?: string; check?: string[]; setup?: string[] } = {}): string {
  const name = opts.name ?? 'echo';
  const dir = join(typesDir, name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(JOB_TOOL, join(dir, 'scripts', 'tool.mjs'));
  writeTypeYaml(dir, {
    name,
    version: 1,
    description: 'Test pack whose tool is a Node script.',
    inputs: { source: { extensions: ['.txt'], max_mb: 1, required: false } },
    params: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: ['ok', 'slow', 'exit', 'hang', 'env', 'json-dir'], default: 'ok' },
        code: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
        ms: { type: 'integer', minimum: 0, maximum: 60_000, default: 0 },
        pid_file: { type: 'string', maxLength: 1000 },
      },
    },
    max_runtime: opts.maxRuntime ?? '10m',
    tools: ['node'],
    ...(opts.setup ? { setup: opts.setup } : {}),
    check: opts.check ?? ['{tool.node}', '-e', 'process.exit(0)'],
    run: ['{tool.node}', '{pack}/scripts/tool.mjs', '--params', '{params_json}', '--out', '{out}', '--input', '{input.source}'],
  });
  return dir;
}

export function fakeClaim(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: '01JTESTJOB0000000000000000',
    lease: 'lease-1',
    lease_until: new Date(Date.now() + 600_000).toISOString(),
    attempt: 1,
    type: 'echo',
    contract_hash: '',
    params: {},
    inputs: [],
    ...overrides,
  };
}

type Call = { method: keyof JobApi; args: unknown[] };

/** A recording stand-in for the server. Any method can be replaced; uploaded file contents land in `uploads`. */
export function fakeApi(overrides: Partial<JobApi> = {}) {
  const calls: Call[] = [];
  const uploads = new Map<string, string>();
  const defaults: JobApi = {
    heartbeat: async () => ({ cancel: false }),
    fail: async (_id, _lease, _error, permanent) => (permanent ? 'failed' : 'queued'),
    release: async () => {},
    downloadInput: async (_id, _lease, _input, dest) => writeFileSync(dest, 'hello'),
    uploadOutput: async (_id, _lease, name, _kind, file) => {
      uploads.set(name, readFileSync(file, 'utf8'));
    },
    complete: async () => {},
  };
  const api = {} as Record<keyof JobApi, (...args: unknown[]) => Promise<unknown>>;
  for (const method of Object.keys(defaults) as (keyof JobApi)[]) {
    const impl = (overrides[method] ?? defaults[method]) as (...args: unknown[]) => Promise<unknown>;
    api[method] = (...args) => {
      calls.push({ method, args });
      return impl(...args);
    };
  }
  return { api: api as unknown as JobApi, calls, uploads, called: (m: keyof JobApi) => calls.filter((c) => c.method === m) };
}
