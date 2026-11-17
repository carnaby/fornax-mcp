import { describe, expect, test } from 'vitest';
import { claimJob } from '../src/domain/queue.js';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const h = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup() {
  announce(t.db, [renderContract, transcribeContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  const eve = issueToken(t.db, 'eve');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'BLENDER');
  return { alice, eve, scene };
}
const submit = (token: string, payload: object) => t.app.inject({ method: 'POST', url: '/api/jobs', headers: h(token), payload });

describe('submit', () => {
  test('a valid job is queued with defaults filled in', async () => {
    const { alice, scene } = await setup();
    const res = await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      type: 'render', state: 'queued', priority: 'normal', params: { frame_start: 1, samples: 128 }, inputs: { scene }, position: 1, type_unavailable: false,
    });
  });

  test('a file is input of one job only', async () => {
    const { alice, scene } = await setup();
    await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    expect((await submit(alice, { type: 'render', params: { frame_start: 2 }, inputs: { scene } })).statusCode).toBe(409);
  });

  test('unknown or withdrawn types, bad params, missing or wrong inputs are 422', async () => {
    const { alice, scene } = await setup();
    const wav = await uploadFile(t.app, alice, 'a.wav', 'RIFF');
    expect((await submit(alice, { type: 'upscale', params: {}, inputs: {} })).statusCode).toBe(422);
    const bad = await submit(alice, { type: 'render', params: { frame_start: -1 }, inputs: { scene } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toContain('frame_start');
    expect((await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: {} })).statusCode).toBe(422);
    expect((await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene: wav } })).statusCode).toBe(422);
    expect((await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene, extra: wav } })).statusCode).toBe(422);
    announce(t.db, [transcribeContract], t.clock.now);
    expect((await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).statusCode).toBe(422);
  });

  test("another client's file is 404", async () => {
    const { eve, scene } = await setup();
    expect((await submit(eve, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).statusCode).toBe(404);
  });

  test('priority orders the queue position', async () => {
    const { alice, scene } = await setup();
    const other = await uploadFile(t.app, alice, 'b.blend', 'B');
    await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    const high = await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene: other }, priority: 'high' });
    expect(high.json().position).toBe(1);
  });
});

describe('read and cancel', () => {
  test('clients see only their own jobs', async () => {
    const { alice, eve, scene } = await setup();
    const id = (await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene }, group: 'anim-1' })).json().id;
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs', headers: h(alice) })).json().jobs).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs?group=anim-1', headers: h(alice) })).json().jobs).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs', headers: h(eve) })).json().jobs).toHaveLength(0);
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: h(eve) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: h(eve) })).statusCode).toBe(404);
  });

  test('cancel a queued job; cancelling again is 409', async () => {
    const { alice, scene } = await setup();
    const id = (await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).json().id;
    const res = await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: h(alice) });
    expect(res.json()).toMatchObject({ state: 'canceled', position: null });
    expect((await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: h(alice) })).statusCode).toBe(409);
  });

  test('a queued job of a withdrawn type is flagged', async () => {
    const { alice, scene } = await setup();
    const id = (await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).json().id;
    announce(t.db, [transcribeContract], t.clock.now);
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: h(alice) })).json()).toMatchObject({ state: 'queued', type_unavailable: true });
  });
});

describe('priorities over REST (spec 07 § 4.1)', () => {
  test('low is taken as normal; a batch type without priority is idle and warned', async () => {
    const { alice, scene } = await setup();
    announce(t.db, [renderContract, transcribeContract, { ...renderContract, name: 'batch', default_priority: 'idle' }], t.clock.now);
    const low = await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene }, priority: 'low' });
    expect(low.statusCode).toBe(201);
    expect(low.json().priority).toBe('normal');
    expect(low.json().warning).toBeUndefined();
    const scene2 = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const batch = await submit(alice, { type: 'batch', params: { frame_start: 1 }, inputs: { scene: scene2 } });
    expect(batch.json()).toMatchObject({ priority: 'idle', position: null, warning: 'this job waits until the operator starts it; pass priority normal to run it automatically' });
  });

  test('priority and requeue of your own job; another owner 404; bad body 400; wrong state 409', async () => {
    const { alice, eve, scene } = await setup();
    const id = (await submit(alice, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).json().id;
    const post = (token: string, what: string, payload: object) => t.app.inject({ method: 'POST', url: `/api/jobs/${id}/${what}`, headers: h(token), payload });
    const high = await post(alice, 'priority', { priority: 'high' });
    expect(high.statusCode).toBe(200);
    expect(high.json()).toMatchObject({ id, priority: 'high', note: expect.any(String) });
    expect((await post(eve, 'priority', { priority: 'idle' })).statusCode).toBe(404);
    expect((await post(alice, 'priority', { priority: 'urgent' })).statusCode).toBe(400);
    expect((await post(alice, 'requeue', {})).statusCode).toBe(409);
    claimJob(t.db, t.clock.now);
    expect((await post(alice, 'priority', { priority: 'idle' })).statusCode).toBe(409);
    const back = await post(alice, 'requeue', {});
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ id, state: 'queued', priority: 'high' });
  });
});
