import { expect, test } from 'vitest';
import { useTestApp } from './helpers.js';

const t = useTestApp();

test('GET /healthz answers ok', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
