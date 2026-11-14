import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToken } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { WorkerApi } from '../src/api.js';
import { ClientApi } from '../src/client-api.js';
import { saveClientToken } from '../src/config.js';
import { type LeaseRequest, type LeaseTimings, runLease } from '../src/lease/run.js';
import { runWorker } from '../src/loop.js';
import { loadPack } from '../src/pack.js';
import type { Paths } from '../src/paths.js';
import { shippedPack } from '../src/shipped.js';
import { clientOf, isAlive, LEASE_PROGRAM, readJson, readPids, testPaths, useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
const stops: AbortController[] = [];
const workers: Promise<number>[] = [];
/** Wrappers run in this process: stopped (their program with them) after each test, also after a failed one. */
const leases: { stop: AbortController; run: Promise<number> }[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  const running = leases.splice(0);
  for (const l of running) l.stop.abort('SIGINT');
  await Promise.allSettled(running.map((l) => l.run));
  for (const s of stops.splice(0)) s.abort();
  await Promise.all(workers.splice(0));
  for (const s of servers.splice(0)) await s.close();
});

/**
 * This process's environment without FORNAX_* variables: a real FORNAX_CLIENT_TOKEN or FORNAX_LEASE of whoever runs
 * the tests, or their own directories, never reach a wrapper here.
 */
const baseEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^fornax_/i.test(k)));

/** The bundled CLI, built once: the tests that need a real process (stdio, exit code, nesting) run it. */
let bundle: string;
let cli: string;
beforeAll(() => {
  bundle = mkdtempSync(join(tmpdir(), 'fornax-lease-cli-'));
  const script = fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, bundle], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  cli = join(bundle, 'fornax-worker', 'fornax.mjs');
}, 120_000);
afterAll(() => rmSync(bundle, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const leaseContract = () => loadPack(shippedPack('lease')!).contract;
type Station = { s: TestServer; paths: Paths; alice: string; rest: ReturnType<typeof clientOf>; startWorker: () => { stop: () => Promise<number> } };

/** A server and a worker PC: the lease pack installed, worker.yaml written, alice's client token issued. */
async function station(opts: { port?: number; raw?: string; pack?: boolean; paths?: Paths } = {}): Promise<Station> {
  const s = await startTestServer(opts.port ? { port: opts.port } : {});
  servers.push(s);
  // Synchronously after the start, before any request is served: alice exists and lease is offered at once.
  const alice = s.issueToken('alice', 'client', opts.raw);
  if (opts.pack !== false) s.announce([leaseContract()]);
  const workerToken = s.issueToken('pc', 'worker');
  const paths = opts.paths ?? testPaths(tmp());
  if (opts.pack !== false) cpSync(shippedPack('lease')!, join(paths.typesDir, 'lease'), { recursive: true });
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.configFile, `server: ${s.url}\n`);
  const startWorker = () => {
    const stop = new AbortController();
    stops.push(stop);
    const done = runWorker({
      api: new WorkerApi({ server: s.url, token: workerToken }), paths, tools: {}, out: () => {}, signal: stop.signal,
      jobOptions: { heartbeatMs: 200, killGraceMs: 500 },
    });
    workers.push(done);
    return {
      stop: async () => {
        stop.abort();
        return done;
      },
    };
  };
  return { s, paths, alice, rest: clientOf(s, alice), startWorker };
}

const fast: Partial<LeaseTimings> = { interruptMs: 500, killGraceMs: 500, backoff: { baseMs: 50, maxMs: 200 } };

/** runLease in this process against `server` with alice's token, with the test program. */
function leaseAt(server: string, token: string, leasesDir: string, args: string[], o: Partial<LeaseRequest> = {}, timings: Partial<LeaseTimings> = {}) {
  const lines: string[] = [];
  const stop = new AbortController();
  const run = runLease(
    { minutes: 60, waitMinutes: null, rerun: false, priority: 'normal', label: 'test', program: process.execPath, args: [LEASE_PROGRAM, ...args], ...o },
    {
      api: new ClientApi({ server, token }), leasesDir, say: (l) => lines.push(l),
      signal: stop.signal, env: baseEnv(), cwd: tmp(), timings: { ...fast, ...timings },
    },
  );
  leases.push({ stop, run });
  return { run, lines };
}

const lease = (st: Pick<Station, 's' | 'paths' | 'alice'>, args: string[], o: Partial<LeaseRequest> = {}, timings: Partial<LeaseTimings> = {}) =>
  leaseAt(st.s.url, st.alice, st.paths.leasesDir, args, o, timings);

/** The bundled CLI as a process, with the station's directories. */
function runCli(st: Station, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...baseEnv(), FORNAX_CONFIG_DIR: st.paths.configDir, FORNAX_DATA_DIR: st.paths.dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => (stdout += String(b)));
  child.stderr.on('data', (b: Buffer) => (stderr += String(b)));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

/**
 * The worker is up: it has checked its packs and announced them (its first request; the station's own announce does not
 * count, it touches no worker state). Each station's server is fresh, so the worker seen is this one.
 */
const ready = (st: Station) => waitFor(async () => ((await st.rest.call('GET', '/api/queue')).worker as { online: boolean }).online, 10_000, 'the worker to be up');

/** The lease job ends succeeded: its tool exited 0 without outputs, and the worker completed it so. */
const succeeds = async (st: Station, id: string) => {
  await waitFor(async () => (await st.rest.job(id)).state === 'succeeded', 10_000, 'the job to succeed');
  expect((await st.rest.job(id)).outputs).toEqual([]);
};

describe('fornax lease against a real server and worker', () => {
  test('on an empty queue the program starts within 5 s and the job succeeds after it', async () => {
    const st = await station();
    st.startWorker();
    await ready(st);
    const report = join(tmp(), 'report.json');
    const t0 = Date.now();
    const l = lease(st, ['--report', report, '--exit', '0']);
    const r = await waitFor(() => readJson<{ at: number; lease: string }>(report), 10_000, 'the program');
    expect(r.at - t0).toBeLessThan(5000);
    expect(await l.run).toBe(0);
    await succeeds(st, r.lease);
  });

  test('two wrappers at once run one after the other, never together', async () => {
    const st = await station();
    st.startWorker();
    await ready(st);
    const runs = join(tmp(), 'runs.txt');
    const a = lease(st, ['--runs', runs, '--sleep', '700']);
    const b = lease(st, ['--runs', runs, '--sleep', '700']);
    expect(await Promise.all([a.run, b.run])).toEqual([0, 0]);
    const events = readFileSync(runs, 'utf8').trim().split('\n').map((x) => x.split(' ')[1]);
    expect(events).toEqual(['start', 'end', 'start', 'end']);
  });

  test("the CLI: the program's stdout, stderr and exit code pass through; it gets FORNAX_LEASE, never the client token", async () => {
    const st = await station();
    st.startWorker();
    await ready(st);
    const report = join(tmp(), 'report.json');
    const r = await runCli(st, ['lease', '--minutes', '5', '--', process.execPath, LEASE_PROGRAM, '--report', report, '--print', 'to stdout', '--eprint', 'to stderr', '--exit', '7'], {
      FORNAX_CLIENT_TOKEN: st.alice,
    });
    expect(r.code).toBe(7);
    expect(r.stdout).toBe('to stdout\n');
    expect(r.stderr).toContain('to stderr');
    expect(r.stderr).toMatch(/^fornax lease: /m);
    expect(r.stderr).not.toContain(st.alice);
    const rep = readJson<{ lease: string; fornax: string[] }>(report)!;
    expect(rep.lease).toMatch(/^[0-9A-Z]{26}$/);
    expect(rep.fornax).toContain('FORNAX_LEASE');
    expect(rep.fornax).not.toContain('FORNAX_CLIENT_TOKEN');
    // The program's own non-zero code is not the lease's: the lease job still succeeds.
    await succeeds(st, rep.lease);
  });

  test('the CLI: a batch file or a missing program, or a usage error, ends with 120 before any job', async () => {
    const st = await station();
    for (const args of [['lease', '--', 'build.cmd'], ['lease', '--', 'no-such-program-here'], ['lease', '--minutes', '0', '--', process.execPath]]) {
      const r = await runCli(st, args, { FORNAX_CLIENT_TOKEN: st.alice });
      expect(r.code, args.join(' ')).toBe(120);
    }
    expect((await st.rest.call('GET', '/api/jobs')).jobs).toEqual([]);
  });

  test('nested: fornax lease inside a lease runs the program at once, without a new job', async () => {
    const st = await station();
    st.startWorker();
    await ready(st);
    // The outer wrapper keeps the token from its program, so the inner one reads the stored file.
    saveClientToken(st.paths, st.alice);
    const report = join(tmp(), 'report.json');
    const r = await runCli(st, ['lease', '--', process.execPath, cli, 'lease', '--', process.execPath, LEASE_PROGRAM, '--report', report, '--exit', '3']);
    expect(r.code, r.stderr).toBe(3);
    const jobs = (await st.rest.call('GET', '/api/jobs')).jobs as { id: string }[];
    expect(jobs).toHaveLength(1);
    expect(readJson<{ lease: string }>(report)!.lease).toBe(jobs[0]!.id);
  });

  test('canceled over REST while the program runs: the tree is killed, 123', async () => {
    const st = await station();
    st.startWorker();
    await ready(st);
    const pids = join(tmp(), 'pids.json');
    const report = join(tmp(), 'report.json');
    const l = lease(st, ['--tree', pids, '--report', report, '--forever']);
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
    const id = (await waitFor(() => readJson<{ lease: string }>(report), 10_000, 'the report')).lease;
    await st.rest.cancel(id);
    expect(await l.run).toBe(123);
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect((await st.rest.job(id)).state).toBe('canceled');
  });

  test('a stopped worker without --rerun: the program is stopped and the job canceled, 123', async () => {
    const st = await station();
    const w = st.startWorker();
    await ready(st);
    const report = join(tmp(), 'report.json');
    const l = lease(st, ['--report', report, '--forever']);
    const id = (await waitFor(() => readJson<{ lease: string }>(report), 10_000, 'the program')).lease;
    await w.stop();
    expect(await l.run).toBe(123);
    expect((await st.rest.job(id)).state).toBe('canceled');
  });

  test('--rerun: a worker restart stops the program and runs it again once the worker is back', async () => {
    const st = await station();
    const w = st.startWorker();
    await ready(st);
    const runs = join(tmp(), 'runs.txt');
    const report = join(tmp(), 'report.json');
    // Long enough to outlive the worker's stop and the give-back, also on a slow machine.
    const l = lease(st, ['--runs', runs, '--report', report, '--sleep', '5000'], { rerun: true });
    const id = (await waitFor(() => readJson<{ lease: string }>(report), 10_000, 'the first run')).lease;
    await w.stop();
    await waitFor(() => l.lines.includes('fornax lease: the worker gave the lease back; the program will start again when the lease returns'), 10_000, 'the give-back');
    expect((await st.rest.job(id)).state).toBe('queued');
    st.startWorker();
    expect(await l.run).toBe(0);
    expect(readFileSync(runs, 'utf8').split('\n').filter((x) => x.includes(' start '))).toHaveLength(2);
    await succeeds(st, id);
  });

  test('--wait-minutes with the worker stopped: 122, the job canceled', async () => {
    const st = await station();
    const l = lease(st, ['--exit', '0'], { waitMinutes: 1 }, { minuteMs: 500, pollS: 1 });
    expect(await l.run).toBe(122);
    const jobs = (await st.rest.call('GET', '/api/jobs')).jobs as { state: string }[];
    expect(jobs.map((j) => j.state)).toEqual(['canceled']);
  });

  test('no lease: an unknown token 121; a server where lease is not offered 121 with the install sentence', async () => {
    const st = await station({ pack: false });
    const unknown = lease({ ...st, alice: generateToken('nobody') }, ['--exit', '0']);
    expect(await unknown.run).toBe(121);
    expect(unknown.lines).toContain('fornax lease: the client token was refused (store a new one with fornax lease token)');
    const l = lease(st, ['--exit', '0']);
    expect(await l.run).toBe(121);
    expect(l.lines).toContain('fornax lease: the worker does not offer the job type lease: run fornax types install lease on the worker PC, then restart the worker');
  });

  test('a server unreachable at submit: retried until it is up, then the lease runs', async () => {
    // A port that was free a moment ago. Another process may bind it before the server below does (it then fails with
    // EADDRINUSE); a retry on another port is not possible, the wrapper already knows this one. The window is ~300 ms
    // on 127.0.0.1 and the OS hands out ephemeral ports in rotation, so this is rare enough for a test.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const raw = generateToken('alice');
    const paths = testPaths(tmp());
    const l = leaseAt(`http://127.0.0.1:${port}`, raw, paths.leasesDir, ['--exit', '0']);
    await new Promise((r) => setTimeout(r, 300));
    // The same worker PC: the wrapper and the worker share the data directory, so the tool sees `done`.
    const st = await station({ port, raw, paths });
    st.startWorker();
    expect(await l.run).toBe(0);
    expect(l.lines).toContain('fornax lease: the server cannot be reached, retrying');
    const jobs = (await st.rest.call('GET', '/api/jobs')).jobs as { id: string }[];
    await succeeds(st, jobs[0]!.id);
  });
});
