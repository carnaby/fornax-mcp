import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { generateToken, jobTypeContract } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, InputMismatchError, isTransient, LeaseLostError, LocalFileError, NetworkError, UploadFileError, WorkerApi } from '../src/api.js';
import { WORKER_VERSION } from '../src/version.js';
import { clientOf, useTempDir, waitFor } from './helpers.js';

// Every FileHandle opened through node:fs/promises, to see whether an upload closes its file.
const opened = vi.hoisted(() => [] as FileHandle[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      opened.push(handle);
      return handle;
    },
  };
});

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
    expect(await api.heartbeat(job.id, job.lease, 0.5, 'half')).toEqual({ cancel: false, requeued: false });
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

  test('an input that cannot be written here is a LocalFileError without the local path, not a network error', async () => {
    const { api, job } = await runningJob();
    const dir = tmp();
    const err = await api.downloadInput(job.id, job.lease, job.inputs[0]!, join(dir, 'missing', 'source.txt')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalFileError);
    expect(isTransient(err)).toBe(false);
    expect((err as Error).message).toBe('input source could not be written here (ENOENT)');
  });

  test('a download the network breaks off mid-body is a NetworkError (retried), not a local error; the next try succeeds', async () => {
    const content = Buffer.alloc(100_000, 7);
    let requests = 0;
    const fake = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(content.length) });
      // The first answer stops after 1000 bytes and the connection is reset; the second is whole.
      if (++requests === 1) res.write(content.subarray(0, 1000), () => setTimeout(() => res.socket?.destroy(), 50));
      else res.end(content);
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const { port } = fake.address() as { port: number };
    try {
      const api = new WorkerApi({ server: `http://127.0.0.1:${port}`, token: generateToken('pc') });
      const input = { name: 'source', file_name: 'a.txt', size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
      const dest = join(tmp(), 'source.txt');
      const err = await api.downloadInput('J1', 'L1', input, dest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect(isTransient(err)).toBe(true);
      expect(existsSync(dest)).toBe(false);
      await api.downloadInput('J1', 'L1', input, dest);
      expect(readFileSync(dest)).toEqual(content);
    } finally {
      fake.closeAllConnections();
      await new Promise((r) => fake.close(r));
    }
  });

  test('a heartbeat past its time limit is a NetworkError (worth another try), not an abort', async () => {
    // Takes the request and never answers: a half-open connection.
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const { port } = silent.address() as { port: number };
    try {
      const api = new WorkerApi({ server: `http://127.0.0.1:${port}`, token: generateToken('pc') });
      const err = await api.heartbeat('J1', 'L1', 0.5, null, AbortSignal.timeout(100)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect(isTransient(err)).toBe(true);
    } finally {
      silent.closeAllConnections();
      await new Promise((r) => silent.close(r));
    }
  });

  test('a 409 before the body is read leaves no handle open on the file', async () => {
    const fake = createServer((req, res) => {
      // Answer after the first chunk and read no more: the client's body stream stalls with the file open.
      req.once('data', () => {
        req.pause();
        res.writeHead(409, { 'content-type': 'application/json' }).end('{"error":"conflict","message":"not yours"}');
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const { port } = fake.address() as { port: number };
    try {
      const file = join(tmp(), 'big.bin');
      writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 7));
      const api = new WorkerApi({ server: `http://127.0.0.1:${port}`, token: generateToken('pc') });
      opened.length = 0;
      await expect(api.uploadOutput('J1', 'L1', 'big.bin', 'output', file, undefined, 16 * 1024 * 1024)).rejects.toBeInstanceOf(LeaseLostError);
      expect(opened).toHaveLength(1);
      // A closed FileHandle has fd -1. An open one would keep the job directory from being removed on older Windows.
      await waitFor(() => opened[0]!.fd === -1, 3000, 'the file handle to close');
    } finally {
      fake.closeAllConnections();
      await new Promise((r) => fake.close(r));
    }
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

  test('an upload sends exactly the expected size; a file that grew or shrank is an UploadFileError, not a network error', async () => {
    const received: number[] = [];
    const fake = createServer((req, res) => {
      let n = 0;
      req.on('data', (c: Buffer) => (n += c.length));
      req.on('error', () => {});
      req.on('end', () => {
        received.push(n);
        res.writeHead(201, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const { port } = fake.address() as { port: number };
    try {
      const api = new WorkerApi({ server: `http://127.0.0.1:${port}`, token: generateToken('pc') });
      const file = join(tmp(), 'result.txt');
      writeFileSync(file, Buffer.alloc(200_000, 7));
      await expect(api.uploadOutput('J1', 'L1', 'result.txt', 'output', file, undefined, 100_000)).rejects.toBeInstanceOf(UploadFileError);
      await expect(api.uploadOutput('J1', 'L1', 'result.txt', 'output', file, undefined, 300_000)).rejects.toBeInstanceOf(UploadFileError);
      await api.uploadOutput('J1', 'L1', 'result.txt', 'output', file, undefined, 200_000);
      // Only the upload whose size matched reached its end.
      expect(received).toEqual([200_000]);
    } finally {
      fake.closeAllConnections();
      await new Promise((r) => fake.close(r));
    }
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

test('a version warning from the server is reported once', async () => {
  const token = s.issueToken('pc', 'worker');
  const seen: string[] = [];
  const old = new WorkerApi({ server: s.url, token, version: '0.0.9', onWarning: (m) => seen.push(m) });
  await old.ping();
  await old.ping();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain('this worker is 0.0.9');
  expect(seen[0]).toContain('/downloads/fornax-worker.zip');
  const same: string[] = [];
  await new WorkerApi({ server: s.url, token, onWarning: (m) => same.push(m) }).ping();
  expect(same).toEqual([]);
});
