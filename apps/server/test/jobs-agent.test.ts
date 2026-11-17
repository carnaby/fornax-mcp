import { AGENT_RULE } from '@fornax/protocol';
import { expect, test } from 'vitest';
import { leaseContract } from './fixtures.js';
import { announce, issueToken, useTestApp } from './helpers.js';
import { bearerHeader, callJson, callTool, useMcp } from './mcp-helpers.js';

const t = useTestApp();
const mcp = useMcp(() => t.app);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('REST and MCP keep agent; get_job, list_jobs and the operator queue show it; none is null (spec 09 § 2)', async () => {
  announce(t.db, [leaseContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  // Distinct created_at keep list and queue order fixed.
  t.clock.advance(1);
  const rest = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'lease', params: { minutes: 5 }, agent: 'agent-a' } });
  expect(rest.statusCode).toBe(201);
  expect(rest.json().agent).toBe('agent-a');
  t.clock.advance(1);
  const plain = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'lease', params: { minutes: 5 } } })).json();
  expect(plain.agent).toBeNull();

  const client = await mcp.connect('/mcp', bearerHeader(alice));
  t.clock.advance(1);
  const sub = await callJson(client, 'submit_job', { type: 'lease', params: { minutes: 5 }, agent: 'agent-b' });
  expect((await callJson(client, 'get_job', { job_id: sub.job_id })).agent).toBe('agent-b');
  const listed = (await callJson(client, 'list_jobs', {})).jobs.map((j: { agent: string | null }) => j.agent);
  expect(listed).toEqual(['agent-b', null, 'agent-a']);

  const q = (await t.app.inject({ method: 'GET', url: '/api/worker/jobs', headers: bearer(worker) })).json();
  expect(q.queued.map((j: { agent: string | null }) => j.agent)).toEqual(['agent-a', null, 'agent-b']);
});

test('a bad agent is 422 with the rule, in REST and MCP; an empty one is no agent', async () => {
  announce(t.db, [leaseContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  for (const agent of ['a;b', '-a', 'x'.repeat(81)]) {
    const r = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'lease', params: { minutes: 5 }, agent } });
    expect(r.statusCode, agent).toBe(422);
    expect(r.json().message, agent).toBe(`agent ${AGENT_RULE}`);
  }
  const client = await mcp.connect('/mcp', bearerHeader(alice));
  expect((await callTool(client, 'submit_job', { type: 'lease', params: { minutes: 5 }, agent: 'a;b' })).text).toBe(`422: agent ${AGENT_RULE}`);
  const empty = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'lease', params: { minutes: 5 }, agent: '' } })).json();
  expect(empty.agent).toBeNull();
});
