import { describe, expect, test } from 'vitest';
import { submitJob } from '../src/domain/jobs.js';
import { workerOnline } from '../src/domain/worker-state.js';
import { leaseContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, useTestApp } from './helpers.js';

const t = useTestApp();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function setup() {
  announce(t.db, [leaseContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const client = issueToken(t.db, 'bob');
  const lease = () => {
    const row = submitJob(t.db, t.config, tokenIdOf(t.db, 'bob'), { type: 'lease', params: { minutes: 5 }, inputs: {} }, t.clock.now);
    t.clock.advance(1);
    return row.id;
  };
  return { worker, client, lease };
}

describe('operator API (spec 06 2.3)', () => {
  test('the queue view; only the worker token opens it', async () => {
    const { worker, client, lease } = setup();
    const a = lease();
    const res = await t.app.inject({ method: 'GET', url: '/api/worker/jobs', headers: auth(worker) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paused: false, running: null, queued: [{ id: a, owner: 'bob', result_url: expect.stringMatching(/^https:\/\/fornax\.example\.com\/r\//) }] });
    expect((await t.app.inject({ method: 'GET', url: '/api/worker/jobs', headers: auth(client) })).statusCode).toBe(401);
  });

  test('operator calls are quiet: they do not make the worker look online', async () => {
    const { worker, lease } = setup();
    const a = lease();
    await t.app.inject({ method: 'GET', url: '/api/worker/jobs', headers: auth(worker) });
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/move`, headers: auth(worker), payload: { to: 'top' } });
    await t.app.inject({ method: 'PUT', url: '/api/worker/pause', headers: auth(worker), payload: { paused: true } });
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/cancel`, headers: auth(worker) });
    expect(workerOnline(t.db, t.clock.now)).toEqual({ online: false, last_seen: null, waiting: null });
  });

  test('move: answers the new view; 409 for a job that does not wait, 404 unknown, 400 bad body', async () => {
    const { worker, lease } = setup();
    const a = lease();
    const b = lease();
    const moved = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${b}/move`, headers: auth(worker), payload: { to: 'top' } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().queued.map((j: { id: string }) => j.id)).toEqual([b, a]);
    await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(worker), payload: { wait: 0 } });
    const late = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${b}/move`, headers: auth(worker), payload: { to: 'bottom' } });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ message: `job ${b} is running now; only waiting jobs move` });
    expect((await t.app.inject({ method: 'POST', url: '/api/worker/jobs/nope/move', headers: auth(worker), payload: { to: 'top' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/move`, headers: auth(worker), payload: { to: 'middle' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/move`, headers: auth(worker), payload: { to: 'top', before: b } })).statusCode).toBe(400);
  });

  test('cancel: any owner\'s job; a finished one is 409', async () => {
    const { worker, lease } = setup();
    const a = lease();
    const res = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/cancel`, headers: auth(worker) });
    expect(res.statusCode).toBe(200);
    expect(res.json().finished[0]).toMatchObject({ id: a, state: 'canceled' });
    expect((await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/cancel`, headers: auth(worker) })).statusCode).toBe(409);
  });

  test('pause and resume answer the view; a bad body is 400', async () => {
    const { worker } = setup();
    const p = await t.app.inject({ method: 'PUT', url: '/api/worker/pause', headers: auth(worker), payload: { paused: true } });
    expect(p.json()).toMatchObject({ paused: true });
    const r = await t.app.inject({ method: 'PUT', url: '/api/worker/pause', headers: auth(worker), payload: { paused: false } });
    expect(r.json()).toMatchObject({ paused: false });
    expect((await t.app.inject({ method: 'PUT', url: '/api/worker/pause', headers: auth(worker), payload: { paused: 'yes' } })).statusCode).toBe(400);
  });

  test('long-poll: answers at once without change, after a change, or after the wait', async () => {
    const { worker, lease } = setup();
    const a = lease();
    const first = (await t.app.inject({ method: 'GET', url: '/api/worker/jobs?wait=5', headers: auth(worker) })).json();
    const started = Date.now();
    const pending = t.app.inject({ method: 'GET', url: `/api/worker/jobs?wait=10&change=${first.change}`, headers: auth(worker) });
    await new Promise((r) => setTimeout(r, 100));
    await t.app.inject({ method: 'PUT', url: '/api/worker/pause', headers: auth(worker), payload: { paused: true } });
    const changed = (await pending).json();
    expect(changed.paused).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    const quietStart = Date.now();
    const same = (await t.app.inject({ method: 'GET', url: `/api/worker/jobs?wait=1&change=${changed.change}`, headers: auth(worker) })).json();
    expect(same.change).toBe(changed.change);
    expect(Date.now() - quietStart).toBeGreaterThanOrEqual(900);
    expect(same.queued[0].id).toBe(a);
  });
});
