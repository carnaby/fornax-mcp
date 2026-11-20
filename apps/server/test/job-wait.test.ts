import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { expireLeases, LEASE_MS } from '../src/domain/queue.js';
import { jobChanges } from '../src/domain/signal.js';
import { leaseContract } from './fixtures.js';
import { announce, issueToken, until, useTestApp } from './helpers.js';

const t = useTestApp();
const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup() {
  announce(t.db, [leaseContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: as(alice), payload: { type: 'lease', params: { minutes: 5 } } })).json();
  const get = (query = '') => t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}${query}`, headers: as(alice) });
  const claim = async () => (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: as(worker), payload: { wait: 0 } })).json();
  const beat = (lease: string, progress: number | null) =>
    t.app.inject({ method: 'POST', url: `/api/worker/jobs/${job.id}/heartbeat`, headers: as(worker), payload: { lease, progress } });
  /** A waiting GET started now: its answer and how long it took. */
  const waiting = (change: string, seconds = 10) => {
    const t0 = Date.now();
    return get(`?wait=${seconds}&change=${change}`).then((r) => ({ status: r.statusCode, body: r.json(), ms: Date.now() - t0 }));
  };
  return { alice, job, get, claim, beat, waiting };
}

test('a job carries a change that stays while nothing it covers changes', async () => {
  const { job, get, claim, beat } = await setup();
  expect(job.change).toMatch(/^[0-9a-f]{16}$/);
  expect((await get()).json().change).toBe(job.change);
  const running = await claim();
  const a = (await get()).json();
  expect(a.change).not.toBe(job.change);
  await beat(running.lease, null);
  expect((await get()).json().change).toBe(a.change);
  await beat(running.lease, 0.5);
  expect((await get()).json().change).not.toBe(a.change);
});

test('a priority change answers a waiting GET at once, even when the position stays (deferred 07 #3)', async () => {
  const { alice, job, waiting } = await setup();
  const pending = waiting(job.change);
  await until(() => jobChanges.waiting === 1);
  const set = await t.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/priority`, headers: as(alice), payload: { priority: 'high' } });
  expect(set.statusCode).toBe(200);
  const r = await pending;
  expect(r.body).toMatchObject({ priority: 'high', position: job.position });
  expect(r.body.change).not.toBe(job.change);
  expect(r.ms).toBeLessThan(5000);
});

test('without change, or with another one, the answer comes at once', async () => {
  const { get } = await setup();
  for (const q of ['?wait=10', '?wait=10&change=0000000000000000']) {
    const t0 = Date.now();
    expect((await get(q)).statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
  }
});

test('with the current change it answers as soon as the job is claimed', async () => {
  const { job, claim, waiting } = await setup();
  const pending = waiting(job.change);
  await until(() => jobChanges.waiting === 1);
  await claim();
  const r = await pending;
  expect(r.body).toMatchObject({ state: 'running' });
  expect(r.body.change).not.toBe(job.change);
  expect(r.ms).toBeLessThan(5000);
});

test('progress, an expired lease and a cancel wake it too', async () => {
  const { job, alice, get, claim, beat, waiting } = await setup();
  const running = await claim();
  let pending = waiting((await get()).json().change);
  await until(() => jobChanges.waiting === 1);
  await beat(running.lease, 0.25);
  let r = await pending;
  expect(r.body.progress).toBe(0.25);
  expect(r.ms).toBeLessThan(5000);

  pending = waiting(r.body.change);
  await until(() => jobChanges.waiting === 1);
  t.clock.advance(LEASE_MS + 1);
  expireLeases(t.db, t.clock.now);
  r = await pending;
  expect(r.body.state).toBe('queued');

  pending = waiting(r.body.change);
  await until(() => jobChanges.waiting === 1);
  await t.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: as(alice) });
  r = await pending;
  expect(r.body.state).toBe('canceled');
});

test('when nothing changes it answers after the wait, with the same change', async () => {
  const { job, waiting } = await setup();
  const r = await waiting(job.change, 1);
  expect(r.ms).toBeGreaterThanOrEqual(900);
  expect(r.body.change).toBe(job.change);
  expect(jobChanges.waiting).toBe(0);
});

test("another job's change wakes it, but it waits on for its own", async () => {
  const { job, alice, waiting } = await setup();
  const pending = waiting(job.change, 2);
  await until(() => jobChanges.waiting === 1);
  // A later created_at keeps the first job ahead in the queue: its position does not move.
  t.clock.advance(1);
  await t.app.inject({ method: 'POST', url: '/api/jobs', headers: as(alice), payload: { type: 'lease', params: { minutes: 1 } } });
  const r = await pending;
  expect(r.ms).toBeGreaterThanOrEqual(1900);
  expect(r.body.change).toBe(job.change);
});

test('a client that hangs up leaves no waiter behind', async () => {
  const { job, alice } = await setup();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.address() as AddressInfo).port;
  const abort = new AbortController();
  const req = fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}?wait=30&change=${job.change}`, { headers: as(alice), signal: abort.signal }).catch(() => null);
  await until(() => jobChanges.waiting === 1);
  abort.abort();
  await req;
  await until(() => jobChanges.waiting === 0);
});

test('wait is 0 to 30 seconds', async () => {
  const { get } = await setup();
  expect((await get('?wait=31')).statusCode).toBe(400);
  expect((await get('?wait=-1')).statusCode).toBe(400);
  expect((await get('?wait=0')).statusCode).toBe(200);
});
