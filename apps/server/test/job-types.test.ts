import { describe, expect, test } from 'vitest';
import { jobTypes } from '../src/db/schema.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { issueToken, useTestApp } from './helpers.js';

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

  test('worker presence expires after 90 s', async () => {
    const worker = issueToken(t.db, 'pc', 'worker');
    const client = issueToken(t.db, 'alice');
    await t.app.inject({ method: 'PUT', url: '/api/worker/types', headers: w(worker), payload: { types: [] } });
    t.clock.advance(90_001);
    const types = (await t.app.inject({ method: 'GET', url: '/api/types', headers: { authorization: `Bearer ${client}` } })).json();
    expect(types.worker.online).toBe(false);
  });
});
