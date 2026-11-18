import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { tokens } from '../src/db/schema.js';
import { leaseContract, renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();

test("queue status shows counts and the running job; its message only to the job's owner", async () => {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const eve = issueToken(t.db, 'eve');
  for (const name of ['a.blend', 'b.blend']) {
    const scene = await uploadFile(t.app, alice, name, 'B');
    await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } });
  }
  const job = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${worker}`, 'x-fornax-worker': 'gpu-pc' }, payload: { wait: 0 } })).json();
  await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${job.id}/heartbeat`, headers: { authorization: `Bearer ${worker}` }, payload: { lease: job.lease, progress: 0.5, message: 'half' } });

  const q = (await t.app.inject({ method: 'GET', url: '/api/queue', headers: { authorization: `Bearer ${eve}` } })).json();
  expect(q).toEqual({
    queued: 1, idle: 0, running: 1, paused: false,
    worker: { online: true, last_seen: expect.any(String), waiting: null },
    current: { type: 'render', agent: null, owner: 'alice', label: null, progress: 0.5, progress_message: null, started_at: t.clock.now.toISOString() },
    ahead: [{ position: 1, type: 'render', agent: null, owner: 'alice', label: null, priority: 'normal', created_at: t.clock.now.toISOString() }],
  });
  expect(JSON.stringify(q)).not.toContain(job.id);
  const own = (await t.app.inject({ method: 'GET', url: '/api/queue', headers: { authorization: `Bearer ${alice}` } })).json();
  expect(own.current).toEqual({ type: 'render', agent: null, owner: 'alice', label: null, progress: 0.5, progress_message: 'half', started_at: t.clock.now.toISOString() });

  const wq = (await t.app.inject({ method: 'GET', url: '/api/worker/queue', headers: { authorization: `Bearer ${worker}` } })).json();
  expect(wq).toEqual({ queued: 1, running: 1, unavailable: [] });
});

const labelled = { ...leaseContract, params: { ...leaseContract.params, properties: { ...leaseContract.params.properties, label: { type: 'string', maxLength: 80 } } } };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function people() {
  announce(t.db, [labelled, { ...labelled, name: 'hold' }], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const bob = issueToken(t.db, 'bob');
  const submit = async (token: string, payload: Record<string, unknown> = {}) => {
    t.clock.advance(1);
    const r = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(token), payload: { type: 'lease', params: { minutes: 5 }, ...payload } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const claim = async () => (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json();
  const queue = async (token: string, jobId?: string) => {
    const r = await t.app.inject({ method: 'GET', url: `/api/queue${jobId ? `?job_id=${jobId}` : ''}`, headers: bearer(token) });
    return { status: r.statusCode, body: r.json() };
  };
  return { alice, bob, submit, claim, queue };
}

test('current names the running job: agent, token, label (spec 09 § 3.2)', async () => {
  const { alice, bob, submit, claim, queue } = people();
  await submit(bob, { params: { minutes: 5, label: 'workbench dock' }, agent: 'agent-b' });
  await claim();
  const q = (await queue(alice)).body;
  expect(q.current).toEqual({ type: 'lease', agent: 'agent-b', owner: 'bob', label: 'workbench dock', progress: null, progress_message: null, started_at: t.clock.now.toISOString() });
  expect(q.ahead).toEqual([]);
});

test('current of a job whose token is gone: owner null', async () => {
  const { alice, bob, submit, claim, queue } = people();
  await submit(bob);
  await claim();
  t.db.delete(tokens).where(eq(tokens.name, 'bob')).run();
  expect((await queue(alice)).body.current).toMatchObject({ agent: null, owner: null });
});

test('ahead without job_id: every job that can start, in queue order; idle and types not offered left out', async () => {
  const { alice, bob, submit, claim, queue } = people();
  await submit(alice);
  await claim();
  await submit(bob, { agent: 'agent-b', params: { minutes: 5, label: 'first' } });
  await submit(alice, { priority: 'idle' });
  await submit(alice, { type: 'hold' });
  await submit(alice, { agent: 'agent-a', priority: 'high' });
  announce(t.db, [labelled], t.clock.now);
  const q = (await queue(alice)).body;
  expect(q.ahead).toEqual([
    { position: 1, type: 'lease', agent: 'agent-a', owner: 'alice', label: null, priority: 'high', created_at: expect.any(String) },
    { position: 2, type: 'lease', agent: 'agent-b', owner: 'bob', label: 'first', priority: 'normal', created_at: expect.any(String) },
  ]);
  expect(JSON.stringify(q.ahead)).not.toMatch(/"id"|progress_message/);
});

test("ahead with job_id cuts at that job, not at the token's first one; null once it has no place; another owner's job is 404", async () => {
  const { alice, bob, submit, claim, queue } = people();
  await submit(alice);
  await claim();
  const first = await submit(bob, { agent: 'agent-b' });
  await submit(alice, { agent: 'agent-c' });
  const mine = await submit(alice, { agent: 'agent-a' });
  expect((await queue(alice, mine)).body.ahead.map((j: { agent: string }) => j.agent)).toEqual(['agent-b', 'agent-c']);
  expect((await queue(bob, first)).body.ahead).toEqual([]);
  expect((await queue(bob, mine)).status).toBe(404);
  await t.app.inject({ method: 'POST', url: `/api/jobs/${mine}/priority`, headers: bearer(alice), payload: { priority: 'idle' } });
  expect((await queue(alice, mine)).body.ahead).toBeNull();
});

test('ahead without job_id tells two agents on one token apart', async () => {
  const { alice, bob, submit, queue } = people();
  await submit(alice, { agent: 'agent-a' });
  await submit(alice, { agent: 'agent-b' });
  const ahead = (await queue(bob)).body.ahead;
  expect(ahead.map((j: { agent: string; owner: string }) => [j.agent, j.owner])).toEqual([['agent-a', 'alice'], ['agent-b', 'alice']]);
});

test('a waiting job whose token is gone stays in ahead: owner null, its agent kept', async () => {
  const { alice, bob, submit, queue } = people();
  await submit(bob, { agent: 'agent-b' });
  await submit(bob);
  t.db.delete(tokens).where(eq(tokens.name, 'bob')).run();
  const ahead = (await queue(alice)).body.ahead;
  expect(ahead.map((j: { position: number; agent: string | null; owner: string | null }) => [j.position, j.agent, j.owner])).toEqual([[1, 'agent-b', null], [2, null, null]]);
});

test('ahead holds at most 20 jobs', async () => {
  const { alice, submit, queue } = people();
  for (let i = 0; i < 22; i++) await submit(alice);
  const ahead = (await queue(alice)).body.ahead;
  expect(ahead).toHaveLength(20);
  expect(ahead[19].position).toBe(20);
});
