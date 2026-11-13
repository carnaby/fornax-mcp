import { expect, test } from 'vitest';
import { buildApp } from '../src/http/app.js';

test('GET /healthz answers ok', async () => {
  const app = await buildApp({});
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  await app.close();
});
