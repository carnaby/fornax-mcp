import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { jobs } from '../src/db/schema.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';
import { bearerHeader, callJson, useMcp } from './mcp-helpers.js';

const t = useTestApp();
const mcp = useMcp(() => t.app);

/** Alice's render job, finished with `count` made-up outputs (frame_0001.png …), written straight into its manifest. */
async function finishedWith(count: number) {
  announce(t.db, [renderContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  const res = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } });
  const id = res.json().id as string;
  const outputs = Array.from({ length: count }, (_, i) => ({
    name: `frame_${String(i + 1).padStart(4, '0')}.png`, file_id: `F${i}`, mime: 'image/png', size: 100 + i, sha256: 'x', meta: null, preview: null,
  }));
  t.db.update(jobs).set({ state: 'succeeded', manifest: { outputs, log: 'log.txt' }, finishedAt: t.clock.now }).where(eq(jobs.id, id)).run();
  return { alice, id, client: await mcp.connect('/mcp', bearerHeader(alice)) };
}

describe('get_job pages its outputs (spec 13 § 5.1)', () => {
  test('20 by default, then the next page from outputs_next_offset', async () => {
    const { id, client } = await finishedWith(45);
    const first = await callJson(client, 'get_job', { job_id: id });
    expect(first.outputs.map((o: { name: string }) => o.name)).toEqual(Array.from({ length: 20 }, (_, i) => `frame_${String(i + 1).padStart(4, '0')}.png`));
    expect(first).toMatchObject({ outputs_total: 45, outputs_next_offset: 20, result_url: expect.stringContaining('/r/') });
    const last = await callJson(client, 'get_job', { job_id: id, outputs_offset: 40, outputs_limit: 20 });
    expect(last.outputs.map((o: { name: string }) => o.name)).toEqual(['frame_0041.png', 'frame_0042.png', 'frame_0043.png', 'frame_0044.png', 'frame_0045.png']);
    expect(last.outputs_next_offset).toBeNull();
  });

  test('the change is the same for every page', async () => {
    const { id, client } = await finishedWith(45);
    const a = await callJson(client, 'get_job', { job_id: id });
    const b = await callJson(client, 'get_job', { job_id: id, outputs_offset: 20 });
    expect(b.change).toBe(a.change);
    // A wait with the current change and another page answers after its time, not at once.
    const started = Date.now();
    await callJson(client, 'get_job', { job_id: id, outputs_offset: 20, change: a.change, wait_seconds: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test('an offset past the end gives an empty page; a limit over 200 is refused', async () => {
    const { id, client } = await finishedWith(3);
    expect(await callJson(client, 'get_job', { job_id: id, outputs_offset: 3 })).toMatchObject({ outputs: [], outputs_total: 3, outputs_next_offset: null });
    // The SDK answers invalid arguments with an error result or a thrown protocol error: either is a refusal.
    const refused = await client.callTool({ name: 'get_job', arguments: { job_id: id, outputs_limit: 201 } }).then((r) => r.isError === true, () => true);
    expect(refused).toBe(true);
  });

  test('a job without outputs has null counts', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const id = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } })).json().id as string;
    const client = await mcp.connect('/mcp', bearerHeader(alice));
    expect(await callJson(client, 'get_job', { job_id: id })).toMatchObject({ outputs: null, outputs_total: null, outputs_bytes: null, outputs_next_offset: null });
  });
});

describe('list_jobs (spec 13 § 5.2)', () => {
  test('counts and result_url instead of the output list', async () => {
    const { client } = await finishedWith(120);
    const { jobs: list } = await callJson(client, 'list_jobs');
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('outputs');
    expect(list[0]).toMatchObject({ outputs_total: 120, outputs_bytes: 120 * 100 + (119 * 120) / 2, result_url: expect.stringContaining('/r/') });
  });
});

describe('REST is unchanged (spec 13 § 5.4)', () => {
  test('REST keeps the full output list', async () => {
    const { alice, id } = await finishedWith(45);
    const one = (await t.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { authorization: `Bearer ${alice}` } })).json();
    expect(one.outputs).toHaveLength(45);
    expect(one).not.toHaveProperty('outputs_total');
    const all = (await t.app.inject({ method: 'GET', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` } })).json();
    expect(all.jobs[0].outputs).toHaveLength(45);
  });
});
