import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORNAX_VERSION } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { saveToken } from '../src/config.js';
import { loadPack } from '../src/pack.js';
import { clientOf, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const BUNDLE = fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url));
let out: string;
let cli: string;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'fornax-tray-modes-'));
  const r = spawnSync(process.execPath, [BUNDLE, out], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  cli = join(out, 'fornax-worker', 'fornax.mjs');
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const tmp = useTempDir();
const servers: TestServer[] = [];
const procs: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  for (const s of servers.splice(0)) await s.close();
});

/** A server with the echo type offered, and a worker configuration (worker.yaml, token, echo pack) for the CLI. */
async function setup() {
  const s = await startTestServer();
  servers.push(s);
  const root = tmp();
  const paths = testPaths(root);
  const pack = writeEchoPack(paths.typesDir);
  s.announce([loadPack(pack).contract]);
  mkdirSync(paths.configDir, { recursive: true });
  // JSON strings are valid YAML: Windows paths need no escaping by hand.
  writeFileSync(paths.configFile, `server: ${JSON.stringify(s.url)}\ntools:\n  node: ${JSON.stringify(process.execPath)}\n`);
  saveToken(paths, s.issueToken('pc', 'worker'));
  const env = { ...process.env, FORNAX_CONFIG_DIR: paths.configDir, FORNAX_DATA_DIR: paths.dataDir, FORNAX_CLIENT_TOKEN: '' };
  return { s, env, client: clientOf(s, s.issueToken('alice')) };
}

function start(args: string[], env: NodeJS.ProcessEnv) {
  const p = spawn(process.execPath, [cli, ...args], { env, stdio: 'pipe', windowsHide: true });
  procs.push(p);
  const lines: string[] = [];
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d: string) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const stderr: string[] = [];
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d: string) => stderr.push(d));
  const exited = new Promise<number | null>((r) => p.once('exit', (code) => r(code)));
  return { p, lines, stderr, exited, events: () => lines.map((l) => JSON.parse(l) as { event: string; [k: string]: unknown }) };
}

const offering = (w: ReturnType<typeof start>) => waitFor(() => w.lines.some((l) => l.includes('offering: echo')), 30_000, 'the worker offering echo');

describe('fornax worker --events (spec 06 3.2)', () => {
  test('JSON lines only; stop gives the running job back and ends with code 0', async () => {
    const { env, client } = await setup();
    const w = start(['worker', '--events'], env);
    await offering(w);
    const job = await client.submit('echo', { mode: 'slow', ms: 60_000 });
    await waitFor(async () => (await client.job(job.id)).state === 'running', 30_000, 'the job running');
    w.p.stdin.write('stop\n');
    expect(await w.exited).toBe(0);
    const events = w.events();
    expect(events[0]).toMatchObject({ event: 'started', version: FORNAX_VERSION, pid: expect.any(Number) });
    expect(events.at(-1)).toEqual({ event: 'stopped', code: 0 });
    expect(events.every((e) => ['started', 'log', 'restarting', 'stopped'].includes(e.event))).toBe(true);
    expect(await client.job(job.id)).toMatchObject({ state: 'queued', attempts: 0 });
  }, 90_000);

  test('a closed stdin stops it like a stop line', async () => {
    const { env } = await setup();
    const w = start(['worker', '--events'], env);
    await offering(w);
    w.p.stdin.end();
    expect(await w.exited).toBe(0);
    expect(w.events().at(-1)).toEqual({ event: 'stopped', code: 0 });
  }, 60_000);

  test('a second worker on the PC says so and stops with 1', async () => {
    const { env } = await setup();
    const first = start(['worker', '--events'], env);
    await offering(first);
    const second = start(['worker', '--events'], env);
    expect(await second.exited).toBe(1);
    const events = second.events();
    expect(events.some((e) => e.event === 'log' && String(e.line).startsWith('another fornax worker runs on this PC'))).toBe(true);
    expect(events.at(-1)).toEqual({ event: 'stopped', code: 1 });
    first.p.stdin.write('stop\n');
    expect(await first.exited).toBe(0);
  }, 90_000);
});

describe('fornax queue --watch (spec 06 3.1)', () => {
  test('--json: a line per change; ends when stdin closes', async () => {
    const { env, client } = await setup();
    const q = start(['queue', '--json', '--watch'], env);
    await waitFor(() => q.lines.length >= 1, 30_000, 'the first line');
    expect(JSON.parse(q.lines[0]!)).toMatchObject({ ok: true, paused: false, queued: [] });
    const job = await client.submit('echo', { mode: 'ok' });
    await waitFor(() => q.lines.some((l) => (JSON.parse(l) as { queued?: { id: string }[] }).queued?.some((j) => j.id === job.id)), 30_000, 'the job in a line');
    q.p.stdin.end();
    expect(await q.exited).toBe(0);
  }, 60_000);

  test('without --json a closed stdin does not end it', async () => {
    const { env } = await setup();
    const q = start(['queue', '--watch'], env);
    await waitFor(() => q.lines.some((l) => l.startsWith('queue active')), 30_000, 'the first view');
    q.p.stdin.end();
    await new Promise((r) => setTimeout(r, 1500));
    expect(q.p.exitCode).toBeNull();
  }, 60_000);
});
