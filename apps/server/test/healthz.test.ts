import { expect, test } from 'vitest';
import { buildApp, MAINTENANCE_STALE_MS } from '../src/http/app.js';
import { useTestApp } from './helpers.js';

const t = useTestApp();

test('GET /healthz answers ok', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test('/healthz is 503 when the maintenance loop has not finished a pass for over 10 minutes', async () => {
  let at = t.clock.now;
  const app = await buildApp({ config: t.config, db: t.db, clock: () => t.clock.now, maintenanceAt: () => at, logStream: { write: () => undefined } });
  try {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    t.clock.advance(MAINTENANCE_STALE_MS);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    t.clock.advance(1);
    const stale = await app.inject({ method: 'GET', url: '/healthz' });
    expect(stale.statusCode).toBe(503);
    expect(stale.json()).toEqual({ ok: false, error: 'maintenance_stalled' });
    at = t.clock.now;
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
