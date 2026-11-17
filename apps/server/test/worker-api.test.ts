import { requeueJob } from '../src/domain/priority.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { FORNAX_VERSION } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { submitJob } from '../src/domain/jobs.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const w = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'x-fornax-worker': 'gpu-pc', ...extra });

async function setup() {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'BLENDER');
  const sub = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` }, payload: { type: 'render', params: { frame_start: 3 }, inputs: { scene } } });
  return { worker, alice, scene, jobId: sub.json().id as string };
}

describe('worker API', () => {
  test('claim, download input, heartbeat, progress visible to the client', async () => {
    const { worker, alice, jobId } = await setup();
    const claim = await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } });
    expect(claim.statusCode).toBe(200);
    const job = claim.json();
    expect(job).toMatchObject({ id: jobId, type: 'render', attempt: 1, params: { frame_start: 3, samples: 128 } });
    expect(job.inputs).toEqual([{ name: 'scene', file_name: 'scene.blend', size: 7, sha256: expect.any(String) }]);

    const input = await t.app.inject({ method: 'GET', url: `/api/worker/jobs/${jobId}/inputs/scene`, headers: w(worker, { 'x-fornax-lease': job.lease }) });
    expect(input.body).toBe('BLENDER');
    expect((await t.app.inject({ method: 'GET', url: `/api/worker/jobs/${jobId}/inputs/scene`, headers: w(worker, { 'x-fornax-lease': 'x' }) })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'GET', url: `/api/worker/jobs/${jobId}/inputs/other`, headers: w(worker, { 'x-fornax-lease': job.lease }) })).statusCode).toBe(404);

    const hb = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/heartbeat`, headers: w(worker), payload: { lease: job.lease, progress: 0.25, message: 'frame 1/4' } });
    expect(hb.json()).toMatchObject({ cancel: false });
    const seen = (await t.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { authorization: `Bearer ${alice}` } })).json();
    expect(seen).toMatchObject({ state: 'running', progress: 0.25, progress_message: 'frame 1/4' });
  });

  test('the heartbeat of a requeued run is told to stop (spec 07 § 3.1)', async () => {
    const { worker, jobId } = await setup();
    const job = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    requeueJob(t.db, jobId, { idle: false }, t.clock.now, null);
    const hb = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/heartbeat`, headers: w(worker), payload: { lease: job.lease } });
    expect(hb.statusCode).toBe(200);
    expect(hb.json()).toEqual({ lease_until: null, cancel: true, requeued: true });
  });

  test('an input whose disk file is gone is 404', async () => {
    const { worker, scene, jobId } = await setup();
    const job = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    rmSync(join(t.config.filesDir, scene));
    const res = await t.app.inject({ method: 'GET', url: `/api/worker/jobs/${jobId}/inputs/scene`, headers: w(worker, { 'x-fornax-lease': job.lease }) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  test('an empty queue answers 204 after the wait', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    expect((await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).statusCode).toBe(204);
  });

  test('a waiting claim is woken by a new job', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const worker = issueToken(t.db, 'pc', 'worker');
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const pending = t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 10 } });
    await new Promise((r) => setTimeout(r, 50));
    const owner = tokenIdOf(t.db, 'alice');
    submitJob(t.db, t.config, owner, { type: 'render', params: { frame_start: 1 }, inputs: { scene } }, t.clock.now);
    const started = Date.now();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a worker that hangs up while waiting does not take the next job', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const worker = issueToken(t.db, 'pc', 'worker');
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as { port: number };
    const abort = new AbortController();
    const waiting = fetch(`http://127.0.0.1:${port}/api/worker/jobs/claim`, {
      method: 'POST', headers: { ...w(worker), 'content-type': 'application/json' }, body: JSON.stringify({ wait: 10 }), signal: abort.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await waiting;
    await new Promise((r) => setTimeout(r, 100));
    const owner = tokenIdOf(t.db, 'alice');
    const job = submitJob(t.db, t.config, owner, { type: 'render', params: { frame_start: 1 }, inputs: { scene } }, t.clock.now);
    await new Promise((r) => setTimeout(r, 200));
    const row = (await t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${alice}` } })).json();
    expect(row).toMatchObject({ state: 'queued', attempts: 0 });
  });

  test('fail and release over HTTP', async () => {
    const { worker, jobId } = await setup();
    const job = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    const fail = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/fail`, headers: w(worker), payload: { lease: job.lease, error: 'boom' } });
    expect(fail.json()).toMatchObject({ state: 'queued', retry_at: expect.any(String) });
    t.clock.advance(60_000);
    const again = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    const rel = await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/release`, headers: w(worker), payload: { lease: again.lease } });
    expect(rel.statusCode).toBe(204);
  });

  test('a claim after a lost claim answer gets the same job back without losing an attempt', async () => {
    const { worker, jobId } = await setup();
    const lost = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    const again = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    expect(again).toMatchObject({ id: jobId, attempt: 1 });
    expect(again.lease).not.toBe(lost.lease);
  });

  test('downloading an input confirms the job: abandoning it then counts the attempt', async () => {
    const { worker, jobId } = await setup();
    const first = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    await t.app.inject({ method: 'GET', url: `/api/worker/jobs/${jobId}/inputs/scene`, headers: w(worker, { 'x-fornax-lease': first.lease }) });
    const again = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: w(worker), payload: { wait: 0 } })).json();
    expect(again).toMatchObject({ id: jobId, attempt: 2 });
  });
});

test('a worker of another version gets a warning header with the download link; a matching one gets none', async () => {
  const worker = issueToken(t.db, 'pc', 'worker');
  const ping = (version: string) =>
    t.app.inject({ method: 'GET', url: '/api/worker/ping', headers: { authorization: `Bearer ${worker}`, 'x-fornax-version': version } });
  const old = await ping('0.0.9');
  expect(old.headers['x-fornax-warning']).toBe(
    `this worker is 0.0.9, the server ${FORNAX_VERSION}; run fornax update (or get the worker from https://fornax.example.com/downloads/fornax-worker.zip)`,
  );
  expect((await ping(FORNAX_VERSION)).headers['x-fornax-warning']).toBeUndefined();
});
