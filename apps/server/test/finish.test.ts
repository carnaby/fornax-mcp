import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import type { Db } from '../src/db/client.js';
import { jobs, webhookDeliveries } from '../src/db/schema.js';
import { finishJob } from '../src/domain/finish.js';
import { cancelJob } from '../src/domain/jobs.js';
import { runMaintenance, TYPE_UNAVAILABLE } from '../src/domain/maintenance.js';
import { ABANDONED, abandonRunning, claimJob, confirmJob, expireLeases, LEASE_EXPIRED, LEASE_MS } from '../src/domain/queue.js';
import { FileStore } from '../src/files/store.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const row = (id: string) => t.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const EMPTY = { outputs: [], log: null };

/** Alice's queued render job; the worker token is ready to claim it. */
async function queued() {
  announce(t.db, [renderContract, transcribeContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  const res = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } });
  return { worker, alice, id: res.json().id as string };
}

/** The same job, claimed through the worker API. */
async function claimed() {
  const q = await queued();
  const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(q.worker), payload: { wait: 0 } })).json().lease as string;
  const put = (name: string, body: string, kind = 'output') =>
    t.app.inject({
      method: 'PUT', url: `/api/worker/jobs/${q.id}/outputs/${name}?kind=${kind}`,
      headers: { ...bearer(q.worker), 'content-type': 'application/octet-stream', 'x-fornax-lease': lease }, payload: body,
    });
  const download = (name: string) => t.app.inject({ method: 'GET', url: `/api/jobs/${q.id}/outputs/${name}`, headers: bearer(q.alice) });
  return { ...q, lease, put, download };
}

describe('every final state has a manifest of the same shape', () => {
  test('a canceled queued job', async () => {
    const { alice, id } = await queued();
    await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: bearer(alice) });
    expect(row(id)).toMatchObject({ state: 'canceled', manifest: EMPTY, finishedAt: t.clock.now });
  });

  test('a canceled running job keeps its lease id, so the next heartbeat says cancel', async () => {
    const r = await claimed();
    await t.app.inject({ method: 'POST', url: `/api/jobs/${r.id}/cancel`, headers: bearer(r.alice) });
    expect(row(r.id)).toMatchObject({ state: 'canceled', manifest: EMPTY, leaseId: r.lease, leaseExpiresAt: null });
    const hb = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${r.id}/heartbeat`, headers: bearer(r.worker), payload: { lease: r.lease } });
    expect(hb.json()).toEqual({ lease_until: null, cancel: true });
  });

  test('a lease that runs out on the last attempt', async () => {
    const { id } = await queued();
    for (let i = 0; i < 3; i++) {
      expect(claimJob(t.db, t.clock.now)?.id).toBe(id);
      t.clock.advance(LEASE_MS + 1);
      expireLeases(t.db, t.clock.now);
    }
    expect(row(id)).toMatchObject({ state: 'failed', error: LEASE_EXPIRED, leaseId: null, manifest: EMPTY, finishedAt: t.clock.now });
  });

  test('a confirmed job abandoned on its last attempt', async () => {
    const { id } = await queued();
    for (let i = 0; i < 3; i++) {
      expect(claimJob(t.db, t.clock.now)?.id).toBe(id);
      confirmJob(t.db, id, t.clock.now);
      abandonRunning(t.db, t.clock.now);
    }
    expect(row(id)).toMatchObject({ state: 'failed', error: ABANDONED, leaseId: null, manifest: EMPTY });
  });

  test('a queued job whose type stayed withdrawn', async () => {
    const { id } = await queued();
    announce(t.db, [transcribeContract], t.clock.now);
    t.clock.advance(7 * 86_400_000 + 1);
    await runMaintenance({ config: t.config, db: t.db, store: new FileStore(t.config.filesDir), clock: () => t.clock.now });
    expect(row(id)).toMatchObject({ state: 'failed', error: TYPE_UNAVAILABLE, manifest: EMPTY });
  });

  test('a permanent failure names the log it kept', async () => {
    const r = await claimed();
    await r.put('log.txt', 'boom', 'log');
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${r.id}/fail`, headers: bearer(r.worker), payload: { lease: r.lease, error: 'bad input', permanent: true } });
    expect(row(r.id)).toMatchObject({ state: 'failed', error: 'bad input', manifest: { outputs: [], log: 'log.txt' } });
  });
});

describe('downloads are limited to the manifest', () => {
  test('nothing can be downloaded before the job has finished', async () => {
    const r = await claimed();
    expect((await r.put('a.png', 'PNG')).statusCode).toBe(201);
    expect((await r.download('a.png')).statusCode).toBe(404);
  });

  test('outputs uploaded before a cancel are not served', async () => {
    const r = await claimed();
    await r.put('a.png', 'PNG');
    await t.app.inject({ method: 'POST', url: `/api/jobs/${r.id}/cancel`, headers: bearer(r.alice) });
    expect((await r.download('a.png')).statusCode).toBe(404);
  });

  test('a succeeded job serves its outputs, their previews and the log; inputs never', async () => {
    const r = await claimed();
    await r.put('a.txt', 'A');
    await r.put('previews/a.jpg', 'J');
    await r.put('log.txt', 'L', 'log');
    const done = await t.app.inject({
      method: 'POST', url: `/api/worker/jobs/${r.id}/complete`, headers: bearer(r.worker),
      payload: { lease: r.lease, outputs: { 'a.txt': { preview: 'previews/a.jpg' } } },
    });
    expect(done.statusCode).toBe(200);
    expect((await r.download('a.txt')).body).toBe('A');
    expect((await r.download('previews/a.jpg')).body).toBe('J');
    expect((await r.download('log.txt')).body).toBe('L');
    expect((await r.download('scene.blend')).statusCode).toBe(404);
  });
});

describe('finishJob is guarded by the state its caller saw', () => {
  /** Alice's queued job with a callback, so every final state queues a webhook. */
  async function withCallback() {
    t.config.webhooks = { allowedPrefixes: ['https://app.example.com/hooks/'] };
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const res = await t.app.inject({
      method: 'POST', url: '/api/jobs', headers: bearer(alice),
      payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene }, callback_url: 'https://app.example.com/hooks/x' },
    });
    expect(res.statusCode).toBe(201);
    return { alice, id: res.json().id as string };
  }
  const webhooks = () => t.db.select().from(webhookDeliveries).all();

  test('a stale row (the job already finished by another path) changes nothing and queues no second webhook', async () => {
    const { alice, id } = await withCallback();
    const stale = row(id);
    expect((await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: bearer(alice) })).statusCode).toBe(200);
    expect(webhooks()).toHaveLength(1);
    expect(finishJob(t.db, stale, { state: 'failed', error: 'late' }, t.clock.now)).toBeNull();
    expect(row(id)).toMatchObject({ state: 'canceled', error: null });
    expect(webhooks()).toMatchObject([{ jobId: id, payload: JSON.stringify({ job_id: id, state: 'canceled' }) }]);
  });

  test('cancelJob on a job that moved between its read and its write is 409', async () => {
    const { id } = await withCallback();
    let moved = false;
    // The worker claims the job right before the cancel writes.
    const racing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'update' && !moved) {
          moved = true;
          expect(claimJob(target, t.clock.now)?.id).toBe(id);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    expect(() => cancelJob(racing, tokenIdOf(t.db, 'alice'), id, t.clock.now)).toThrow(expect.objectContaining({ status: 409 }));
    expect(moved).toBe(true);
    expect(row(id)).toMatchObject({ state: 'running', finishedAt: null });
    expect(webhooks()).toEqual([]);
  });
});
