import { describe, expect, test } from 'vitest';
import { jobTypes } from '../src/db/schema.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, useTestApp } from './helpers.js';

const t = useTestApp();
const w = (token: string) => ({ authorization: `Bearer ${token}`, 'x-fornax-worker': 'gpu-pc', 'x-fornax-version': '0.1.0' });

describe('announce', () => {
  test('announced types are offered to clients', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    const client = issueToken(t.db, 'alice');
    const res = await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [renderContract, transcribeContract] } });
    expect(res.json()).toEqual({ offered: ['render', 'transcribe'] });
    const types = (await t.app.inject({ method: 'GET', url: '/api/types', headers: { authorization: `Bearer ${client}` } })).json();
    expect(types.types.map((x: { name: string }) => x.name)).toEqual(['render', 'transcribe']);
    expect(types.types[0].inputs.scene.required).toBe(true);
    expect(types.worker).toMatchObject({ online: true });
  });

  test('a type missing from the next announcement is withdrawn but remembered', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [renderContract, transcribeContract] } });
    t.clock.advance(1000);
    await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [renderContract] } });
    const rows = t.db.select().from(jobTypes).all();
    expect(rows.find((r) => r.name === 'transcribe')).toMatchObject({ offered: false });
    expect(rows.find((r) => r.name === 'render')?.lastOfferedAt.getTime()).toBe(t.clock.now.getTime());
  });

  test('a changed contract replaces the old one', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [renderContract] } });
    await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [{ ...renderContract, version: 2 }] } });
    expect(t.db.select().from(jobTypes).get()?.contract.version).toBe(2);
  });

  test('invalid contracts and duplicate names are refused as a whole', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    const bad = await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [renderContract, { ...transcribeContract, run: ['sh'] }] } });
    expect(bad.statusCode).toBe(400);
    const dup = await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [renderContract, renderContract] } });
    expect(dup.statusCode).toBe(400);
    expect(t.db.select().from(jobTypes).all()).toEqual([]);
  });

  test('an environment line per type is stored and shown; a type without one shows null (spec 12 § 3.2)', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    const client = issueToken(t.db, 'alice');
    const put = (payload: Record<string, unknown>) => t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload });
    const list = async () =>
      (await t.app.inject({ method: 'GET', url: '/api/types', headers: { authorization: `Bearer ${client}` } }))
        .json()
        .types.map((x: { name: string; environment: string | null }) => [x.name, x.environment]);
    const line = 'Blender 5.2.2 LTS, Cycles on OPTIX (Fake GPU)';
    expect((await put({ types: [renderContract, transcribeContract], environments: { render: line } })).statusCode).toBe(200);
    expect(await list()).toEqual([['render', line], ['transcribe', null]]);
    // A worker before 0.14.1 announces without the field: the lines are cleared, not kept from before.
    expect((await put({ types: [renderContract, transcribeContract] })).statusCode).toBe(200);
    expect(await list()).toEqual([['render', null], ['transcribe', null]]);
  });

  test('an environment for a type the announcement does not offer is refused as a whole', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    const res = await t.app.inject({
      method: 'PUT', url: '/api/worker/types', headers: w(worker),
      payload: { types: [renderContract], environments: { render: 'Blender', transcribe: 'faster-whisper' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('transcribe');
    expect(t.db.select().from(jobTypes).all()).toEqual([]);
  });

  test('a type named like an Object property has no environment unless given one', () => {
    announce(t.db, [{ ...renderContract, name: 'constructor' }, { ...renderContract, name: 'tostring' }], t.clock.now, { tostring: 'given' });
    expect(offeredTypes(t.db).map((x) => [x.contract.name, x.environment])).toEqual([['constructor', null], ['tostring', 'given']]);
  });

  test('worker presence expires after 90 s', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    const client = issueToken(t.db, 'alice');
    await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [] } });
    t.clock.advance(90_001);
    const types = (await t.app.inject({ method: 'GET', url: '/api/types', headers: { authorization: `Bearer ${client}` } })).json();
    expect(types.worker.online).toBe(false);
  });
});

import { jobTypeContract } from '@fornax/protocol';
import { offeredTypes, typeView } from '../src/domain/job-types.js';

describe('type view (spec 07 § 4.1, spec 12 § 3.2)', () => {
  test('shows the default priority; normal when the pack names none', () => {
    expect(typeView({ contract: jobTypeContract.parse({ ...renderContract, default_priority: 'idle' }), environment: null }).default_priority).toBe('idle');
    expect(typeView({ contract: jobTypeContract.parse(renderContract), environment: null }).default_priority).toBe('normal');
  });

  test('shows the environment line', () => {
    expect(typeView({ contract: jobTypeContract.parse(renderContract), environment: 'Blender 5.2.2 LTS' }).environment).toBe('Blender 5.2.2 LTS');
  });
});
