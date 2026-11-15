import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { FORNAX_VERSION } from '@fornax/protocol';
import { expect, test } from 'vitest';
import { useTestApp } from './helpers.js';

const t = useTestApp();

test('GET /downloads/fornax-worker.zip serves the bundle without a token', async () => {
  const bytes = Buffer.from('PK\u0005\u0006fake zip');
  writeFileSync(t.config.workerZip, bytes);
  const res = await t.app.inject({ method: 'GET', url: '/downloads/fornax-worker.zip' });
  expect(res.statusCode).toBe(200);
  expect(res.rawPayload.equals(bytes)).toBe(true);
  expect(res.headers['content-type']).toBe('application/zip');
  expect(res.headers['content-disposition']).toBe(`attachment; filename="fornax-worker-${FORNAX_VERSION}.zip"`);
  rmSync(t.config.workerZip);
  expect((await t.app.inject({ method: 'GET', url: '/downloads/fornax-worker.zip' })).statusCode).toBe(404);
});

test('GET /downloads/fornax-worker.json: version, sha256 and size of the bundle, recomputed when the zip changes', async () => {
  const first = Buffer.from('PKfirst');
  writeFileSync(t.config.workerZip, first);
  const a = await t.app.inject({ method: 'GET', url: '/downloads/fornax-worker.json' });
  expect(a.statusCode).toBe(200);
  expect(a.headers['cache-control']).toBe('no-cache');
  expect(a.json()).toEqual({ version: FORNAX_VERSION, sha256: createHash('sha256').update(first).digest('hex'), size: first.length });
  const second = Buffer.from('PKsecond, longer');
  writeFileSync(t.config.workerZip, second);
  const b = await t.app.inject({ method: 'GET', url: '/downloads/fornax-worker.json' });
  expect(b.json()).toEqual({ version: FORNAX_VERSION, sha256: createHash('sha256').update(second).digest('hex'), size: second.length });
  rmSync(t.config.workerZip);
  expect((await t.app.inject({ method: 'GET', url: '/downloads/fornax-worker.json' })).statusCode).toBe(404);
});
