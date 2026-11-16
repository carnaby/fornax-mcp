import { expect, test } from 'vitest';
import { jobChanges } from '../src/domain/signal.js';
import { leaseContract } from './fixtures.js';
import { announce, issueToken, until, useTestApp } from './helpers.js';
import { bearerHeader, callJson, useMcp } from './mcp-helpers.js';

const t = useTestApp();
const mcp = useMcp(() => t.app);
const as = (token: string) => ({ authorization: `Bearer ${token}` });

function setup() {
  announce(t.db, [leaseContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const submit = async () => {
    // Distinct created_at keep the queue order fixed.
    t.clock.advance(1);
    const r = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: as(alice), payload: { type: 'lease', params: { minutes: 5 } } });
    expect(r.statusCode).toBe(201);
    return r.json();
  };
  const get = async (id: string) => (await t.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: as(alice) })).json();
  const w = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url: `/api/worker${url}`, headers: as(worker), ...(payload ? { payload } : {}) });
  return { alice, submit, get, w };
}

test('a worker that never connected', async () => {
  const { submit } = setup();
  const job = await submit();
  expect(job.worker).toEqual({ online: false, last_seen: null, waiting: null });
  expect(job.note).toBe('waiting: the worker has not connected yet; the job starts when the worker runs, asking again changes nothing');
});

test('a worker gone offline: the time is in UTC', async () => {
  const { submit, get, w } = setup();
  await w('GET', '/ping');
  const job = await submit();
  t.clock.advance(91_000);
  expect((await get(job.id)).note).toBe('waiting: the worker is offline since 10:00 UTC; the job starts when the worker runs again, asking again changes nothing');
});

test('a type the worker no longer offers', async () => {
  const { submit, get, w } = setup();
  const job = await submit();
  await w('PUT', '/types', { types: [] });
  expect((await get(job.id)).note).toBe('waiting: the worker does not offer the type lease now; the job starts when it is offered again, or fails after 7 days without it');
});

test('the worker waits for the card: its sentence', async () => {
  const { submit, w } = setup();
  await w('PUT', '/status', { waiting: { reason: 'gpu_busy', used_mib: 5120, total_mib: 16311, limit_mib: 2048 } });
  expect((await submit()).note).toBe('waiting: 5120 MiB of 16311 MiB of the card in use by other programs, limit 2048 MiB');
});

test('MCP: a card that cannot be read is the note of submit_job and get_job', async () => {
  const { alice, w } = setup();
  await w('PUT', '/status', { waiting: { reason: 'gpu_unreadable', error: 'nvidia-smi: exit code 4', limit_mib: 2048 } });
  const note = 'waiting: the worker cannot read the card (nvidia-smi: exit code 4); no job starts until it can, asking again changes nothing';
  const client = await mcp.connect('/mcp', bearerHeader(alice));
  const sub = await callJson(client, 'submit_job', { type: 'lease', params: { minutes: 5 } });
  expect(sub).toMatchObject({ state: 'queued', worker: { online: true, waiting: { reason: 'gpu_unreadable' } }, note });
  expect(await callJson(client, 'get_job', { job_id: sub.job_id })).toMatchObject({ state: 'queued', note });
});

test('the queue: what runs since when, or who goes next; nothing once the job runs', async () => {
  const { submit, get, w } = setup();
  await w('GET', '/ping');
  const first = await submit();
  const second = await submit();
  expect(first.note).toBe('waiting, position 1; the worker takes it next');
  expect(second.note).toBe('waiting, position 2; the worker takes the jobs ahead first');
  const claimed = (await w('POST', '/jobs/claim', { wait: 0 })).json();
  expect(claimed.id).toBe(first.id);
  expect((await get(second.id)).note).toBe('waiting, position 1; running lease since 10:00 UTC');
  expect(await get(first.id)).toMatchObject({ state: 'running', note: null, worker: { online: true, waiting: null } });
});

test('a job waiting for its retry says from when', async () => {
  const { submit, get, w } = setup();
  const job = await submit();
  const claimed = (await w('POST', '/jobs/claim', { wait: 0 })).json();
  await w('POST', `/jobs/${job.id}/fail`, { lease: claimed.lease, error: 'boom' });
  expect((await get(job.id)).note).toBe('waiting, position 1; the worker takes it next; the next attempt starts at 10:01 UTC at the earliest');
});

test('the job list stays without worker and note', async () => {
  const { alice, submit } = setup();
  await submit();
  const list = (await t.app.inject({ method: 'GET', url: '/api/jobs', headers: as(alice) })).json();
  expect(list.jobs[0]).not.toHaveProperty('note');
  expect(list.jobs[0]).not.toHaveProperty('worker');
  expect(list.jobs[0].change).toMatch(/^[0-9a-f]{16}$/);
});

test('MCP: submit_job and get_job carry worker and note; get_job waits for the next change, at most 25 s', async () => {
  const { alice, w } = setup();
  const client = await mcp.connect('/mcp', bearerHeader(alice));
  const sub = await callJson(client, 'submit_job', { type: 'lease', params: { minutes: 5 } });
  expect(sub).toEqual({
    job_id: expect.any(String), state: 'queued', position: 1,
    worker: { online: false, last_seen: null, waiting: null }, note: expect.stringContaining('has not connected yet'),
  });
  const first = await callJson(client, 'get_job', { job_id: sub.job_id });
  expect(first).toMatchObject({ state: 'queued', change: expect.any(String), worker: { online: false }, note: expect.any(String), result_url: expect.any(String) });
  const t0 = Date.now();
  const pending = callJson(client, 'get_job', { job_id: sub.job_id, wait_seconds: 20, change: first.change });
  await until(() => jobChanges.waiting === 1);
  await w('POST', '/jobs/claim', { wait: 0 });
  expect(await pending).toMatchObject({ state: 'running', note: null });
  expect(Date.now() - t0).toBeLessThan(10_000);
  await expect(callJson(client, 'get_job', { job_id: sub.job_id, wait_seconds: 26 })).rejects.toThrow();
});

test('the instructions and get_job tell agents to wait instead of asking again and again', async () => {
  const { alice } = setup();
  const client = await mcp.connect('/mcp', bearerHeader(alice));
  expect(client.getInstructions()).toContain('wait_seconds');
  const { tools } = await client.listTools();
  expect(tools.find((x) => x.name === 'get_job')!.description).toContain(
    'pass `change` from the previous answer and `wait_seconds` to wait for the next change instead of asking again and again',
  );
});
