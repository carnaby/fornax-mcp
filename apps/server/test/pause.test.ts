import { describe, expect, test } from 'vitest';
import { queueControl } from '../src/db/schema.js';
import { jobDetail, submitJob } from '../src/domain/jobs.js';
import { queueStatus } from '../src/domain/maintenance.js';
import { claimJob, failJob, heartbeatJob } from '../src/domain/queue.js';
import { queuePaused, setQueuePaused } from '../src/domain/queue-control.js';
import { jobSignal } from '../src/domain/signal.js';
import { touchWorker } from '../src/domain/worker-state.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, tokenIdOf, until, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();

async function job() {
  announce(t.db, [renderContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  return { alice, row: submitJob(t.db, t.config, tokenIdOf(t.db, 'alice'), { type: 'render', params: { frame_start: 1 }, inputs: { scene } }, t.clock.now) };
}

describe('pause (spec 06 2.2)', () => {
  test('nothing is paused at first', () => {
    expect(queuePaused(t.db)).toBe(false);
  });

  test('paused: a claim gets nothing; resumed: it gets the job', async () => {
    const { row } = await job();
    setQueuePaused(t.db, true, t.clock.now);
    expect(claimJob(t.db, t.clock.now)).toBeNull();
    setQueuePaused(t.db, false, t.clock.now);
    expect(claimJob(t.db, t.clock.now)?.id).toBe(row.id);
  });

  test('the running job goes on while paused', async () => {
    const { row } = await job();
    const claimed = claimJob(t.db, t.clock.now)!;
    setQueuePaused(t.db, true, t.clock.now);
    expect(heartbeatJob(t.db, row.id, claimed.leaseId!, { progress: 0.5, message: null }, t.clock.now)).toMatchObject({ cancel: false });
    expect(failJob(t.db, row.id, claimed.leaseId!, { error: 'done for the test', permanent: true }, t.clock.now).state).toBe('failed');
  });

  test('pausing twice keeps the first time; resuming clears it', () => {
    const first = t.clock.now;
    setQueuePaused(t.db, true, first);
    t.clock.advance(60_000);
    setQueuePaused(t.db, true, t.clock.now);
    expect(t.db.select().from(queueControl).get()).toEqual({ id: 1, paused: true, pausedAt: first });
    setQueuePaused(t.db, false, t.clock.now);
    setQueuePaused(t.db, false, t.clock.now);
    expect(t.db.select().from(queueControl).get()).toEqual({ id: 1, paused: false, pausedAt: null });
  });

  test('resuming wakes a waiting claim at once', async () => {
    await job();
    const worker = issueToken(t.db, 'pc', 'worker');
    setQueuePaused(t.db, true, t.clock.now);
    const pending = t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${worker}` }, payload: { wait: 10 } });
    await until(() => jobSignal.waiting > 0);
    const started = Date.now();
    setQueuePaused(t.db, false, t.clock.now);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('clients see the pause in the queue status and in a waiting job\'s note', async () => {
    const { alice, row } = await job();
    touchWorker(t.db, { tokenId: 'w', hostname: 'pc', version: null }, t.clock.now);
    setQueuePaused(t.db, true, t.clock.now);
    expect(queueStatus(t.db, t.clock.now)).toMatchObject({ paused: true });
    const res = await t.app.inject({ method: 'GET', url: '/api/queue', headers: { authorization: `Bearer ${alice}` } });
    expect(res.json()).toMatchObject({ paused: true });
    expect(jobDetail(t.db, t.config, row, t.clock.now).note).toBe(
      "waiting: the worker's operator paused the queue; the job waits until they resume it, asking again changes nothing",
    );
  });
});
