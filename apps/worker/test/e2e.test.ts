import { join } from 'node:path';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { WorkerApi } from '../src/api.js';
import { runWorker } from '../src/loop.js';
import { clientOf, isAlive, jobsLeft, NODE_TOOLS, readPids, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
const stops: AbortController[] = [];
const workers: Promise<unknown>[] = [];
afterEach(async () => {
  // Stop a worker a failed test left running, wait for it (its tool tree dies), then close the servers.
  for (const c of stops.splice(0)) c.abort();
  await Promise.allSettled(workers.splice(0));
  for (const s of servers.splice(0)) await s.close();
});

/** A server, a paired and approved worker with the echo pack, and a client. The worker serves one job (--once). */
async function setup() {
  const s = await startTestServer();
  servers.push(s);
  const paths = testPaths(tmp());
  writeEchoPack(paths.typesDir);
  const api = new WorkerApi({ server: s.url, token: s.issueToken('pc', 'worker') });
  const alice = clientOf(s, s.issueToken('alice'));
  const out: string[] = [];
  const stop = new AbortController();
  stops.push(stop);
  const worker = runWorker({
    api, paths, tools: NODE_TOOLS, out: (l) => out.push(l), signal: stop.signal, once: true, claimWaitS: 10,
    jobOptions: { heartbeatMs: 200, killGraceMs: 500, retryDelaysMs: [10, 10] },
  });
  workers.push(worker.catch(() => undefined));
  await waitFor(async () => (await alice.offered()).includes('echo'), 10_000, 'echo to be offered');
  return { paths, alice, worker, out };
}

describe('end to end', () => {
  test('upload, submit, worker runs, manifest with meta and preview, download', async () => {
    const { paths, alice, worker, out } = await setup();
    const source = await alice.upload('hello.txt', 'hello');
    const job = await alice.submit('echo', { mode: 'ok' }, { source });
    expect(await worker).toBe(0);
    const done = await alice.job(job.id);
    expect(done).toMatchObject({ state: 'succeeded', progress: 1, log: 'log.txt', error: null });
    expect(done.outputs).toEqual([expect.objectContaining({ name: 'result.txt', meta: { chars: 5 }, preview: 'previews/result.jpg' })]);
    expect(await alice.download(job.id, 'result.txt')).toBe('HELLO');
    expect(await alice.download(job.id, 'previews/result.jpg')).toBe('JPEG');
    expect(await alice.download(job.id, 'log.txt')).toContain('working');
    expect(jobsLeft(paths)).toEqual([]);
    expect(out.join('\n')).not.toContain('hello');
  });

  test('exit code 2 fails the job for good, with the reason and the log', async () => {
    const { alice, worker } = await setup();
    const job = await alice.submit('echo', { mode: 'exit', code: 2 });
    expect(await worker).toBe(0);
    const done = await alice.job(job.id);
    expect(done).toMatchObject({ state: 'failed', attempts: 1, log: 'log.txt', outputs: [] });
    expect(done.error).toContain('bad input');
    expect(await alice.download(job.id, 'log.txt')).toContain('bad input: the file is empty');
  });

  test('cancel during a run: the process tree is gone and the job stays canceled', async () => {
    const { alice, worker } = await setup();
    const pidFile = join(tmp(), 'pids.json');
    const job = await alice.submit('echo', { mode: 'hang', pid_file: pidFile });
    const pids = await waitFor(() => readPids(pidFile), 10_000, 'the tool to start');
    await waitFor(async () => (await alice.job(job.id)).progress_message === 'hanging', 10_000, 'progress to reach the server');
    await alice.cancel(job.id);
    expect(await worker).toBe(0);
    expect(await alice.job(job.id)).toMatchObject({ state: 'canceled' });
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000, 'the tree to die');
  });
});
