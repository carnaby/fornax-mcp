import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { generateToken, jobTypeContract } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiError, InputMismatchError, LeaseLostError, NetworkError, WorkerApi } from '../src/api.js';
import { WORKER_VERSION } from '../src/version.js';
import { clientOf, useTempDir } from './helpers.js';

const tmp = useTempDir();
let s: TestServer;
beforeEach(async () => {
  s = await startTestServer();
});
afterEach(async () => {
  await s.close();
});

const echo = jobTypeContract.parse({
  name: 'echo',
  version: 1,
  description: 'Echo a text file.',
  inputs: { source: { extensions: ['.txt'], max_mb: 1 } },
  params: { type: 'object', additionalProperties: false, properties: { loud: { type: 'boolean', default: false } } },
  max_runtime_s: 60,
});

async function runningJob() {
  const api = new WorkerApi({ server: s.url, token: s.issueToken('pc', 'worker') });
  expect(await api.announce([echo])).toEqual(['echo']);
  const alice = clientOf(s, s.issueToken('alice'));
  const source = await alice.upload('hello.txt', 'hello');
  const submitted = await alice.submit('echo', {}, { source });
  const job = await api.claim(0);
  if (!job) throw new Error('no job was claimed');
  return { api, alice, job, jobId: submitted.id as string };
}

describe('WorkerApi', () => {
  test('a pending token gets 403 with its fingerprint; once approved it gets through', async () => {
    s.invite('pc', 'worker');
    const api = new WorkerApi({ server: s.url, token: generateToken('pc') });
    await expect(api.ping()).rejects.toMatchObject({ status: 403, code: 'pending', message: expect.stringMatching(/[A-Z2-7]{4}-[A-Z2-7]{4}/) });
    s.approve('pc');
    await expect(api.ping()).resolves.toBeUndefined();
  });

  test('an unknown token gets 401', async () => {
    const api = new WorkerApi({ server: s.url, token: generateToken('nobody') });
    const e = await api.ping().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 401 });
  });

  test('round trip: claim, verified input, heartbeat, uploads with "/" in names, complete', async () => {
    const { api, alice, job, jobId } = await runningJob();
    expect(job).toMatchObject({ id: jobId, type: 'echo', attempt: 1, params: { loud: false } });
    const dest = join(tmp(), 'source.txt');
    await api.downloadInput(job.id, job.lease, job.inputs[0]!, dest);
    expect(readFileSync(dest, 'utf8')).toBe('hello');
    expect(await api.heartbeat(job.id, job.lease, 0.5, 'half')).toEqual({ cancel: false });
    const out = join(tmp(), 'result.txt');
    writeFileSync(out, 'HELLO');
    await api.uploadOutput(job.id, job.lease, 'result.txt', 'output', out);
    await api.uploadOutput(job.id, job.lease, 'deep/er/x.txt', 'output', out);
    const log = join(tmp(), 'log.txt');
    writeFileSync(log, 'line 1\n');
    await api.uploadOutput(job.id, job.lease, 'log.txt', 'log', log);
    await api.complete(job.id, job.lease, { 'result.txt': { meta: { chars: 5 } } });
    const seen = await alice.job(jobId);
    expect(seen).toMatchObject({ state: 'succeeded', log: 'log.txt' });
    expect(seen.outputs.map((o: { name: string }) => o.name)).toEqual(['deep/er/x.txt', 'result.txt']);
    expect(await alice.download(jobId, 'deep/er/x.txt')).toBe('HELLO');
  });

  test('a damaged input is refused and removed', async () => {
    const { api, job } = await runningJob();
    const dest = join(tmp(), 'source.txt');
    await expect(api.downloadInput(job.id, job.lease, { ...job.inputs[0]!, sha256: '0'.repeat(64) }, dest)).rejects.toBeInstanceOf(InputMismatchError);
    expect(existsSync(dest)).toBe(false);
  });

  test('a lease that no longer holds is LeaseLostError (409)', async () => {
    const { api, job } = await runningJob();
    await expect(api.heartbeat(job.id, 'not-the-lease', null, null)).rejects.toBeInstanceOf(LeaseLostError);
  });

  test('fail reports what the server did', async () => {
    const { api, job } = await runningJob();
    expect(await api.fail(job.id, job.lease, 'boom', true)).toBe('failed');
  });

  test('release gives the job back without costing an attempt', async () => {
    const { api, alice, job, jobId } = await runningJob();
    await api.release(job.id, job.lease);
    expect(await alice.job(jobId)).toMatchObject({ state: 'queued', attempts: 0 });
  });

  test('nothing to claim answers null; the queue is visible', async () => {
    const api = new WorkerApi({ server: s.url, token: s.issueToken('pc', 'worker') });
    expect(await api.claim(0)).toBeNull();
    expect(await api.queue()).toEqual({ queued: 0, running: 0, unavailable: [] });
  });

  test('a server that cannot be reached is a NetworkError', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const { port } = closed.address() as { port: number };
    await new Promise((r) => closed.close(r));
    const api = new WorkerApi({ server: `http://127.0.0.1:${port}`, token: generateToken('pc') });
    await expect(api.ping()).rejects.toBeInstanceOf(NetworkError);
  });

  test('uploads are streamed with content-length; headers name the worker and its version', async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const fake = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on('end', () => res.writeHead(201, { 'content-type': 'application/json' }).end('{}'));
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const { port } = fake.address() as { port: number };
    try {
      const file = join(tmp(), 'big.bin');
      writeFileSync(file, Buffer.alloc(300_000, 7));
      await new WorkerApi({ server: `http://127.0.0.1:${port}`, token: generateToken('pc') }).uploadOutput('J1', 'L1', 'big.bin', 'output', file);
      expect(seen[0]).toMatchObject({ 'content-length': '300000', 'x-fornax-lease': 'L1', 'x-fornax-version': WORKER_VERSION, 'x-fornax-worker': expect.any(String) });
      expect(seen[0]?.['transfer-encoding']).toBeUndefined();
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });
});
