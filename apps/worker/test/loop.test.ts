import { join } from 'node:path';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, NetworkError, WorkerApi } from '../src/api.js';
import { type LoopApi, runWorker } from '../src/loop.js';
import { clientOf, isAlive, NODE_TOOLS, readPids, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setup() {
  const s = await startTestServer();
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
});
