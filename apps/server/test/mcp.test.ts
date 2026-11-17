import { fingerprint, generateToken } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { createInvite, revokeToken } from '../src/domain/tokens.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';
import { bearerHeader, callJson, callTool, useMcp } from './mcp-helpers.js';

const t = useTestApp();
const mcp = useMcp(() => t.app);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Valid arguments for every tool, so the pending check is not hidden behind input validation. */
const ARGS: Record<string, Record<string, unknown>> = {
  create_upload: { name: 'a.blend' },
  submit_job: { type: 'render' },
  get_job: { job_id: 'x' },
  get_output: { job_id: 'x', name: 'y' },
  cancel_job: { job_id: 'x' },
};

const ping = async (path: string, headers: Record<string, string> = {}) =>
  fetch(`${await mcp.base()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

describe('the MCP endpoint', () => {
  test('offers exactly its tools and the instructions', async () => {
    const client = await mcp.connect('/mcp', bearerHeader(issueToken(t.db, 'alice')));
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(['cancel_job', 'create_upload', 'get_job', 'get_output', 'list_job_types', 'list_jobs', 'queue_status', 'submit_job']);
    for (const tool of tools) expect(tool.description, tool.name).toBeTruthy();
    expect(tools.find((x) => x.name === 'queue_status')!.description).toContain('worker.waiting');
    const ins = client.getInstructions() ?? '';
    expect(ins).toMatch(/^Fornax is a job queue for one GPU worker/);
    expect(ins).toContain('create_upload');
    expect(ins).toContain('<path>');
    expect(ins).toContain('connection reset');
    expect(ins).toContain('--fail-with-body');
    expect(ins).toContain('older than 7.76');
    expect(ins).toContain('curl.exe');
    expect(ins).toMatch(/cannot run commands.*give the user the command/s);
    expect(ins).toContain('get_output');
    expect(ins).toContain('result_url');
  });

  test('the token works in the header and in the path', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    for (const client of [await mcp.connect('/mcp', bearerHeader(alice)), await mcp.connect(`/mcp/${alice}`)]) {
      const r = await callJson(client, 'list_job_types');
      expect(r.types.map((x: { name: string }) => x.name)).toEqual(['render']);
      expect(r.worker).toEqual({ online: false, last_seen: null, waiting: null });
    }
  });

  test('a pending token gets its fingerprint from every tool and no data', async () => {
    createInvite(t.db, { name: 'bob', role: 'client' }, t.clock.now);
    const raw = generateToken('bob');
    // The first use registers the token as pending, like a new claude.ai connector would.
    const client = await mcp.connect(`/mcp/${raw}`);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const r = await callTool(client, tool.name, ARGS[tool.name] ?? {});
      expect(r, tool.name).toEqual({
        isError: true,
        blocks: [{ type: 'text', text: `this token is waiting for approval; fingerprint ${fingerprint(raw)}` }],
        text: `this token is waiting for approval; fingerprint ${fingerprint(raw)}`,
      });
    }
  });

  test('revoked, unknown and worker tokens: 401 with the header, 404 in the path, the token never echoed', async () => {
    const alice = issueToken(t.db, 'alice');
    const worker = issueToken(t.db, 'pc', 'worker');
    revokeToken(t.db, 'alice');
    for (const token of [alice, worker, generateToken('zed'), 'nonsense']) {
      const header = await ping('/mcp', bearerHeader(token));
      expect(header.status, token).toBe(401);
      expect(await header.text()).not.toContain(token);
      const path = await ping(`/mcp/${token}`);
      expect(path.status, token).toBe(404);
      expect(await path.text()).not.toContain(token);
    }
    expect((await ping('/mcp')).status).toBe(401);
  });

  test('a pending worker token is refused like an unknown one: 401 with the header, 404 in the path', async () => {
    for (const [name, use] of [['pc1', 'header'], ['pc2', 'path']] as const) {
      createInvite(t.db, { name, role: 'worker' }, t.clock.now);
      const raw = generateToken(name);
      const res = use === 'header' ? await ping('/mcp', bearerHeader(raw)) : await ping(`/mcp/${raw}`);
      expect(res.status, use).toBe(use === 'header' ? 401 : 404);
      if (use === 'header') expect(res.headers.get('www-authenticate')).toBe('Bearer');
      const body = await res.text();
      expect(body).not.toContain(raw);
      expect(body).not.toContain(fingerprint(raw));
    }
  });

  test('every tool has a title and annotations that tell reading from changing', async () => {
    const client = await mcp.connect('/mcp', bearerHeader(issueToken(t.db, 'alice')));
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const tool of tools) expect(tool.title, tool.name).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    for (const name of ['list_job_types', 'get_job', 'get_output', 'list_jobs', 'queue_status']) {
      expect(byName[name]!.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    expect(byName.cancel_job!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    // A worker beats every 5 s (0.4.1): the promise to the client follows it.
    expect(byName.cancel_job!.description).toContain('within a few seconds');
    expect(byName.create_upload!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(byName.submit_job!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  });

  test('GET and DELETE are 405 on both paths', async () => {
    const alice = issueToken(t.db, 'alice');
    for (const method of ['GET', 'DELETE']) {
      for (const path of ['/mcp', `/mcp/${alice}`, '/mcp/unknown']) {
        const res = await fetch(`${await mcp.base()}${path}`, { method });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
      }
    }
  });
});

describe('the job tools', () => {
  test('create_upload, the upload through its link, submit_job, get_job, list_jobs, cancel_job', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const client = await mcp.connect('/mcp', bearerHeader(issueToken(t.db, 'alice')));
    const link = await callJson(client, 'create_upload', { name: 'scene.blend' });
    expect(link).toEqual({ file_id: expect.any(String), url: expect.any(String), expires_at: '2026-11-13T11:00:00.000Z', curl: expect.any(String) });
    // -T streams the file with PUT (--data-binary would load all of it into memory); the body of a 413 or 404 is shown.
    expect(link.curl).toBe(`curl --fail-with-body -sS -T "<path>" -H "Content-Type: application/octet-stream" "${link.url}"`);
    const put = await t.app.inject({ method: 'PUT', url: new URL(link.url).pathname, headers: { 'content-type': 'application/octet-stream' }, payload: 'BLEND' });
    expect(put.statusCode).toBe(201);

    const submitted = await callJson(client, 'submit_job', { type: 'render', params: { frame_start: 1 }, inputs: { scene: link.file_id }, group: 'shot-1' });
    expect(submitted).toEqual({
      job_id: expect.any(String), state: 'queued', position: 1,
      worker: { online: false, last_seen: null, waiting: null }, note: expect.stringMatching(/^waiting: the worker has not connected yet;/),
    });
    const job = await callJson(client, 'get_job', { job_id: submitted.job_id });
    expect(job).toMatchObject({ id: submitted.job_id, type: 'render', state: 'queued', params: { frame_start: 1, samples: 128 }, type_unavailable: false, group: 'shot-1' });
    expect(job.result_url).toMatch(new RegExp(`^https://fornax\\.example\\.com/r/${submitted.job_id}\\.\\d+\\.[A-Za-z0-9_-]+$`));
    expect((await callJson(client, 'list_jobs', { group: 'shot-1' })).jobs.map((j: { id: string }) => j.id)).toEqual([submitted.job_id]);
    expect((await callJson(client, 'list_jobs', { state: 'running' })).jobs).toEqual([]);
    expect(await callJson(client, 'cancel_job', { job_id: submitted.job_id })).toEqual({ job_id: submitted.job_id, state: 'canceled' });
  });

  test("errors come back as tool errors with their status; another client's job is not found", async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const mine = await mcp.connect('/mcp', bearerHeader(alice));
    const { job_id } = await callJson(mine, 'submit_job', { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    const other = await mcp.connect('/mcp', bearerHeader(issueToken(t.db, 'eve')));
    expect(await callTool(other, 'get_job', { job_id })).toMatchObject({ isError: true, text: `404: job ${job_id} not found` });
    expect(await callTool(other, 'cancel_job', { job_id })).toMatchObject({ isError: true, text: `404: job ${job_id} not found` });
    expect((await callTool(mine, 'submit_job', { type: 'nope' })).text).toMatch(/^422: job type nope is not offered now/);
    expect((await callTool(mine, 'submit_job', { type: 'render', params: { frame_start: -1 } })).text).toMatch(/^422: invalid params/);
    await callJson(mine, 'cancel_job', { job_id });
    expect((await callTool(mine, 'cancel_job', { job_id })).text).toMatch(/^409: /);
  });

  test("queue_status shows the running job's message only to its owner, in MCP and in the REST API", async () => {
    announce(t.db, [renderContract], t.clock.now);
    const worker = issueToken(t.db, 'pc', 'worker');
    const alice = issueToken(t.db, 'alice');
    const eve = issueToken(t.db, 'eve');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } });
    const job = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json();
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${job.id}/heartbeat`, headers: bearer(worker), payload: { lease: job.lease, progress: 0.5, message: 'half' } });

    const own = await callJson(await mcp.connect('/mcp', bearerHeader(alice)), 'queue_status');
    expect(own).toEqual({
      queued: 0, idle: 0, running: 1, paused: false,
      worker: { online: true, last_seen: expect.any(String), waiting: null },
      current: { type: 'render', progress: 0.5, progress_message: 'half', started_at: expect.any(String) },
    });
    const foreign = await callJson(await mcp.connect('/mcp', bearerHeader(eve)), 'queue_status');
    expect(foreign.current).toEqual({ type: 'render', progress: 0.5, progress_message: null, started_at: expect.any(String) });
    expect((await t.app.inject({ method: 'GET', url: '/api/queue', headers: bearer(eve) })).json().current.progress_message).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/queue', headers: bearer(alice) })).json().current.progress_message).toBe('half');
  });
});
