import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, NetworkError, WorkerApi } from '../src/api.js';
import type { GpuReading } from '../src/gpu.js';
import { type LoopApi, runWorker } from '../src/loop.js';
import { clientOf, isAlive, NODE_TOOLS, readPids, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setup(overrides: Parameters<typeof startTestServer>[0] = {}) {
  const s = await startTestServer(overrides);
  servers.push(s);
  const paths = testPaths(tmp());
  writeEchoPack(paths.typesDir);
  const api = new WorkerApi({ server: s.url, token: s.issueToken('pc', 'worker') });
  const alice = clientOf(s, s.issueToken('alice'));
  const out: string[] = [];
  return { paths, api, alice, out, say: (l: string) => out.push(l) };
}
const fast = { claimWaitS: 10, jobOptions: { heartbeatMs: 200, killGraceMs: 500, retryDelaysMs: [10, 10] } };

describe('runWorker', () => {
  test('offers only packs whose check passes; a hanging check is cut off and the worker still starts', async () => {
    const { paths, api, alice, out, say } = await setup();
    writeEchoPack(paths.typesDir, { name: 'sick', check: ['{tool.node}', '-e', 'process.exit(1)'] });
    writeEchoPack(paths.typesDir, { name: 'stuck', check: ['{tool.node}', '-e', 'setInterval(() => 0, 1000)'] });
    const code = await runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: new AbortController().signal, once: true, claimWaitS: 0, checkTimeoutMs: 1000 });
    expect(code).toBe(0);
    expect(await alice.offered()).toEqual(['echo']);
    expect(out).toContain('offering: echo');
    expect(out).toContain('not offered: type pack stuck: check did not finish within 1 s');
    expect(out.some((l) => l.startsWith('not offered: type pack sick: check failed (exit code 1)'))).toBe(true);
  });

  test('exit code 3 withdraws the type and gives the job back without costing an attempt', async () => {
    const { paths, api, alice, say } = await setup();
    const worker = runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: new AbortController().signal, once: true, ...fast });
    await waitFor(async () => (await alice.offered()).includes('echo'), 10_000, 'echo to be offered');
    const job = await alice.submit('echo', { mode: 'exit', code: 3 });
    expect(await worker).toBe(0);
    expect(await alice.offered()).toEqual([]);
    expect(await alice.job(job.id)).toMatchObject({ state: 'queued', attempts: 0, type_unavailable: true });
  });

  test('exit code 4 fails the job after its first attempt', async () => {
    const { paths, api, alice, say } = await setup();
    const worker = runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: new AbortController().signal, once: true, ...fast });
    await waitFor(async () => (await alice.offered()).includes('echo'), 10_000, 'echo to be offered');
    const job = await alice.submit('echo', { mode: 'exit', code: 4 });
    expect(await worker).toBe(0);
    expect(await alice.job(job.id)).toMatchObject({ state: 'failed', attempts: 1, error: expect.stringContaining('(exit code 4)') });
  });

  test('stopping the worker during a job kills the tool and releases the job', async () => {
    const { paths, api, alice, say } = await setup();
    const stop = new AbortController();
    const pidFile = join(tmp(), 'pids.json');
    const worker = runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: stop.signal, ...fast });
    await waitFor(async () => (await alice.offered()).includes('echo'), 10_000, 'echo to be offered');
    const job = await alice.submit('echo', { mode: 'hang', pid_file: pidFile });
    const pids = await waitFor(() => readPids(pidFile), 10_000, 'the tool to start');
    stop.abort();
    expect(await worker).toBe(0);
    expect(await alice.job(job.id)).toMatchObject({ state: 'queued', attempts: 0 });
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000, 'the tree to die');
  });

  test('an unreachable server is retried with a growing pause; a refused token ends the worker with 1', async () => {
    const paths = testPaths(tmp());
    const lines: string[] = [];
    let announces = 0;
    const flaky = {
      announce: async () => {
        if (++announces < 3) throw new NetworkError('cannot reach the server: ECONNREFUSED');
        return [];
      },
      claim: async () => null,
    } as unknown as LoopApi;
    const code = await runWorker({
      api: flaky, paths, tools: {}, out: (l) => lines.push(l), signal: new AbortController().signal, once: true, claimWaitS: 0, backoffMs: { baseMs: 10, maxMs: 40 },
    });
    expect(code).toBe(0);
    expect(announces).toBe(3);
    expect(lines.filter((l) => l.startsWith('the server is unreachable'))).toHaveLength(1);
    expect(lines).toContain('the server is reachable again');

    const refused = {
      announce: async () => {
        throw new ApiError(401, 'unauthorized', 'unauthorized');
      },
    } as unknown as LoopApi;
    expect(await runWorker({ api: refused, paths, tools: {}, out: (l) => lines.push(l), signal: new AbortController().signal, once: true })).toBe(1);
    expect(lines.at(-1)).toMatch(/does not accept this worker token/);
  });

  test('stopping during the checks does not announce the reduced set', async () => {
    const { paths, out, say } = await setup();
    writeEchoPack(paths.typesDir, { name: 'stuck', check: ['{tool.node}', '-e', 'setInterval(() => 0, 1000)'] });
    const stop = new AbortController();
    let announces = 0;
    const api = { announce: async () => (announces++, []), claim: async () => null } as unknown as LoopApi;
    const worker = runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: stop.signal, claimWaitS: 0 });
    setTimeout(() => stop.abort(), 500);
    expect(await worker).toBe(0);
    expect(announces).toBe(0);
    expect(out.some((l) => l.startsWith('offering'))).toBe(false);
  });

  test('the console shows neither a tool message nor a job failure detail', async () => {
    const { paths, api, alice, out, say } = await setup();
    const worker = runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: new AbortController().signal, once: true, ...fast });
    await waitFor(async () => (await alice.offered()).includes('echo'), 10_000, 'echo to be offered');
    const job = await alice.submit('echo', { mode: 'exit', code: 1 });
    expect(await worker).toBe(0);
    expect(await alice.job(job.id)).toMatchObject({ state: 'queued' });
    expect(out.join('\n')).not.toContain('the file is empty');
    expect(out).toContain(`job ${job.id}: retry`);
  });

  test('an output larger than the server allows fails the job for good after one attempt, naming it', async () => {
    // previews/result.jpg (4 bytes) fits, result.txt (8 bytes) does not.
    const { paths, api, alice, say } = await setup({
      limits: { maxUploadBytes: 16 * 1024 * 1024, maxOutputBytes: 6, maxQueuedPerToken: 50 },
    });
    const worker = runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: new AbortController().signal, once: true, ...fast });
    await waitFor(async () => (await alice.offered()).includes('echo'), 10_000, 'echo to be offered');
    const job = await alice.submit('echo', { mode: 'ok' });
    expect(await worker).toBe(0);
    expect(await alice.job(job.id)).toMatchObject({ state: 'failed', attempts: 1, error: expect.stringMatching(/^out\/result\.txt was refused by the server/) });
  });

  test('job options shorten the lease: retries of a server call end within the shortened lease', async () => {
    const { paths, api, alice, out, say } = await setup();
    // complete never gets through; everything else reaches the real server.
    const completeDown = new Proxy(api, {
      get: (target, key) => {
        if (key === 'complete') return async () => {
          throw new NetworkError('cannot reach the server: ECONNREFUSED');
        };
        const v = Reflect.get(target, key) as unknown;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const worker = runWorker({
      api: completeDown, paths, tools: NODE_TOOLS, out: say, signal: new AbortController().signal, once: true, claimWaitS: fast.claimWaitS,
      jobOptions: { ...fast.jobOptions, leaseMs: 1500, leaseMarginMs: 500 },
    });
    await waitFor(async () => (await alice.offered()).includes('echo'), 10_000, 'echo to be offered');
    const job = await alice.submit('echo', { mode: 'ok' });
    const started = Date.now();
    // With the default lease (10 minutes) the retries would go on far past this test's timeout.
    expect(await worker).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toContain(`job ${job.id}: retry`);
    expect(await alice.job(job.id)).toMatchObject({ state: 'queued', attempts: 1 });
  });

  test('a failing check shows a single short line', async () => {
    const { paths, api, out, say } = await setup();
    const script = 'console.log("one\\ntwo " + "z".repeat(400)); process.exitCode = 2';
    writeEchoPack(paths.typesDir, { name: 'noisy', check: ['{tool.node}', '-e', script] });
    await runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: new AbortController().signal, once: true, claimWaitS: 0 });
    const prefix = 'not offered: type pack noisy: check failed (exit code 2): ';
    const line = out.find((x) => x.startsWith(prefix))!;
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.length).toBeLessThanOrEqual(prefix.length + 200);
  });

  test('a busy card keeps the job queued and shows why; once free, the job runs and the reason is gone', async () => {
    const { paths, api, alice, say } = await setup();
    let card: GpuReading = { ok: true, used_mib: 5120, total_mib: 16311, cards: 1 };
    const stop = new AbortController();
    const worker = runWorker({ api, paths, tools: NODE_TOOLS, out: say, signal: stop.signal, ...fast, gpu: { maxUsedMib: 2048, measure: async () => card, pollMs: 50 } });
    await waitFor(async () => (await alice.call('GET', '/api/queue')).worker.waiting?.reason === 'gpu_busy', 10_000, 'the reason in the queue');
    const job = await alice.submit('echo', { mode: 'ok' });
    await sleep(300);
    expect(await alice.job(job.id)).toMatchObject({
      state: 'queued', note: 'waiting: 5120 MiB of 16311 MiB of the card in use by other programs, limit 2048 MiB',
    });
    card = { ok: true, used_mib: 1130, total_mib: 16311, cards: 1 };
    await waitFor(async () => (await alice.job(job.id)).state === 'succeeded', 10_000, 'the job to run');
    expect((await alice.call('GET', '/api/queue')).worker.waiting).toBeNull();
    stop.abort();
    expect(await worker).toBe(0);
  });
});
