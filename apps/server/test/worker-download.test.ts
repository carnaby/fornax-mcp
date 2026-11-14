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
