import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateToken, WORKER_HEADERS } from '@fornax/protocol';
import { describe, expect, test, vi } from 'vitest';
import { WorkerApi, workerHostname } from '../src/api.js';

// A computer name a header cannot carry as it is (not Latin-1).
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), hostname: () => 'Počítač Účtárna' }));

describe('the X-Fornax-Worker header', () => {
  test('is cleaned exactly as the server does: a-z, 0-9, ".", "_" and "-", lower case, else "worker"', () => {
    expect(workerHostname('Render-PC')).toBe('render-pc');
    expect(workerHostname('  gpu01.lan ')).toBe('gpu01.lan');
    expect(workerHostname('Počítač')).toBe('worker');
    expect(workerHostname('-dash')).toBe('worker');
    expect(workerHostname('x'.repeat(64))).toBe('worker');
    expect(workerHostname('')).toBe('worker');
  });

  test('a computer name outside Latin-1 does not break the requests', async () => {
    let seen: IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      await new WorkerApi({ server: `http://127.0.0.1:${port}`, token: generateToken('pc') }).ping();
      expect(seen[WORKER_HEADERS.name]).toBe('worker');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
