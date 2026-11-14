import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateToken } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { NetworkError, WorkerApi } from '../src/api.js';
import { ClientApi } from '../src/client-api.js';
import { loadPack } from '../src/pack.js';
import { shippedPack } from '../src/shipped.js';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function server() {
  const s = await startTestServer();
  servers.push(s);
  return s;
}

describe('ClientApi', () => {
  test('whoami, submit with a note, a wait that ends on a change, cancel', async () => {
    const s = await server();
    const worker = new WorkerApi({ server: s.url, token: s.issueToken('pc', 'worker') });
    await worker.announce([loadPack(shippedPack('lease')!).contract]);
    const api = new ClientApi({ server: s.url, token: s.issueToken('alice') });
    expect(await api.whoami()).toEqual({ name: 'alice', role: 'client' });
    const job = await api.submit({ type: 'lease', params: { minutes: 5, label: 'blender' }, priority: 'normal' });
    expect(job).toMatchObject({ type: 'lease', state: 'queued', position: 1, started_at: null, note: expect.stringContaining('waiting') });
    expect((await api.job(job.id, { wait: 1, change: job.change })).change).toBe(job.change);
    const waiting = api.job(job.id, { wait: 20, change: job.change });
    await worker.claim(0);
    expect(await waiting).toMatchObject({ state: 'running', started_at: expect.any(String), note: null });
    expect((await api.cancel(job.id)).state).toBe('canceled');
  });

  test('a refused token is ApiError 401, a type not offered 422, a server that is gone a NetworkError', async () => {
    const s = await server();
    await expect(new ClientApi({ server: s.url, token: generateToken('nobody') }).whoami()).rejects.toMatchObject({ status: 401 });
    const api = new ClientApi({ server: s.url, token: s.issueToken('alice') });
    await expect(api.submit({ type: 'lease', params: { minutes: 1 }, priority: 'normal' })).rejects.toMatchObject({
      status: 422, message: expect.stringContaining('not offered'),
    });
    const url = s.url;
    await servers.splice(0)[0]!.close();
    await expect(new ClientApi({ server: url, token: generateToken('alice') }).whoami()).rejects.toBeInstanceOf(NetworkError);
  });

  test('a job answer that is not JSON or not a job is a NetworkError (asking again is safe)', async () => {
    const bodies = ['{"id": "x", "sta', '{"id": "x"}'];
    const http = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(bodies.shift());
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      const api = new ClientApi({ server: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token: generateToken('alice') });
      await expect(api.job('x')).rejects.toBeInstanceOf(NetworkError);
      await expect(api.job('x')).rejects.toBeInstanceOf(NetworkError);
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });
});
