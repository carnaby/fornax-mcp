import { expect, test } from 'vitest';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();

test('queue status shows counts and the running job without ids of others', async () => {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const majo = issueToken(t.db, 'majo');
  const eve = issueToken(t.db, 'eve');
  for (const name of ['a.blend', 'b.blend']) {
    const scene = await uploadFile(t.app, majo, name, 'B');
    await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${majo}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } });
  }
  const job = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${worker}`, 'x-fornax-worker': 'gpu-pc' }, payload: { wait: 0 } })).json();
  await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${job.id}/heartbeat`, headers: { authorization: `Bearer ${worker}` }, payload: { lease: job.lease, progress: 0.5, message: 'half' } });

  const q = (await t.app.inject({ method: 'GET', url: '/api/queue', headers: { authorization: `Bearer ${eve}` } })).json();
  expect(q).toEqual({ queued: 1, running: 1, worker: { online: true, last_seen: expect.any(String) }, current: { type: 'render', progress: 0.5, progress_message: 'half' } });
  expect(JSON.stringify(q)).not.toContain(job.id);

  const wq = (await t.app.inject({ method: 'GET', url: '/api/worker/queue', headers: { authorization: `Bearer ${worker}` } })).json();
  expect(wq).toEqual({ queued: 1, running: 1, unavailable: [] });
});
