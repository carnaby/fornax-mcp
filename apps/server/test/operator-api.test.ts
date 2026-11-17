import { describe, expect, test } from 'vitest';
import { submitJob } from '../src/domain/jobs.js';
import { jobChanges } from '../src/domain/signal.js';
import { setWorkerWaiting, touchWorker, WORKER_ONLINE_MS, workerOnline } from '../src/domain/worker-state.js';
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
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/priority`, headers: auth(worker), payload: { priority: 'idle' } });
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/requeue`, headers: auth(worker), payload: {} });
    await t.app.inject({ method: 'POST', url: '/api/worker/idle/start', headers: auth(worker) });
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

  test('long-poll: the worker coming online shows within a second, not after the wait', async () => {
    const { worker } = setup();
    const first = (await t.app.inject({ method: 'GET', url: '/api/worker/jobs', headers: auth(worker) })).json();
    expect(first.worker.online).toBe(false);
    const started = Date.now();
    const pending = t.app.inject({ method: 'GET', url: `/api/worker/jobs?wait=10&change=${first.change}`, headers: auth(worker) });
    await new Promise((r) => setTimeout(r, 100));
    await t.app.inject({ method: 'GET', url: '/api/worker/ping', headers: auth(worker) });
    expect((await pending).json().worker.online).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("long-poll: the worker's reason to wait shows within a second, not after the wait", async () => {
    const { worker } = setup();
    await t.app.inject({ method: 'GET', url: '/api/worker/ping', headers: auth(worker) });
    const first = (await t.app.inject({ method: 'GET', url: '/api/worker/jobs', headers: auth(worker) })).json();
    expect(first.worker).toMatchObject({ online: true, waiting: null });
    const started = Date.now();
    const pending = t.app.inject({ method: 'GET', url: `/api/worker/jobs?wait=10&change=${first.change}`, headers: auth(worker) });
    await new Promise((r) => setTimeout(r, 100));
    const busy = { reason: 'gpu_busy', used_mib: 5120, total_mib: 16311, limit_mib: 2048 };
    await t.app.inject({ method: 'PUT', url: '/api/worker/status', headers: auth(worker), payload: { waiting: busy } });
    expect((await pending).json().worker.waiting).toMatchObject({ reason: 'gpu_busy', used_mib: 5120 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('worker state wakes long-polls only when the view changes (spec 06 2.3)', () => {
  /** Whether `act` wakes a waiter of jobChanges (a waiter not woken runs into its 300 ms). */
  async function wakes(act: () => void): Promise<boolean> {
    const started = Date.now();
    const waiting = jobChanges.wait(300);
    act();
    await waiting;
    return Date.now() - started < 250;
  }
  const touch = (version: string | null = '0.5.0') => touchWorker(t.db, { tokenId: 'w', hostname: 'pc', version }, t.clock.now);
  const busy = { reason: 'gpu_busy' as const, used_mib: 5120, total_mib: 16311, limit_mib: 2048 };

  test('touchWorker: online after missing or offline, and a new version, wake; a heartbeat of an online worker does not', async () => {
    expect(await wakes(() => touch())).toBe(true);
    t.clock.advance(5000);
    expect(await wakes(() => touch())).toBe(false);
    expect(await wakes(() => touch('0.5.1'))).toBe(true);
    t.clock.advance(WORKER_ONLINE_MS + 1);
    expect(await wakes(() => touch('0.5.1'))).toBe(true);
  });

  test('setWorkerWaiting wakes when the reason changes, not when it is the same', async () => {
    touch();
    expect(await wakes(() => setWorkerWaiting(t.db, null))).toBe(false);
    expect(await wakes(() => setWorkerWaiting(t.db, busy))).toBe(true);
    expect(await wakes(() => setWorkerWaiting(t.db, { ...busy }))).toBe(false);
    expect(await wakes(() => setWorkerWaiting(t.db, { ...busy, used_mib: 6000 }))).toBe(true);
    expect(await wakes(() => setWorkerWaiting(t.db, null))).toBe(true);
  });
});

describe('operator priorities (spec 07 § 4.2)', () => {
  test("priority, requeue and Start all for any owner's job answer the view", async () => {
    const { worker, lease } = setup();
    const a = lease();
    const b = lease();
    const idle = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${b}/priority`, headers: auth(worker), payload: { priority: 'idle' } });
    expect(idle.statusCode).toBe(200);
    expect(idle.json().queued.find((j: { id: string }) => j.id === b)).toMatchObject({ priority: 'idle', idle_since: expect.any(String) });
    const started = await t.app.inject({ method: 'POST', url: '/api/worker/idle/start', headers: auth(worker) });
    expect(started.statusCode).toBe(200);
    expect(started.json().queued.find((j: { id: string }) => j.id === b)).toMatchObject({ priority: 'normal', idle_since: null });
    expect((await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/requeue`, headers: auth(worker), payload: {} })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/requeue`, headers: auth(worker) })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${a}/priority`, headers: auth(worker), payload: { priority: 'soon' } })).statusCode).toBe(400);
  });
});
