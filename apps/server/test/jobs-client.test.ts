import { describe, expect, test } from 'vitest';
import { renderContract, transcribeContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const h = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup() {
  announce(t.db, [renderContract, transcribeContract], t.clock.now);
  const majo = issueToken(t.db, 'majo');
  const eve = issueToken(t.db, 'eve');
  const scene = await uploadFile(t.app, majo, 'scene.blend', 'BLENDER');
  return { majo, eve, scene };
}
const submit = (token: string, payload: object) => t.app.inject({ method: 'POST', url: '/api/jobs', headers: h(token), payload });

describe('submit', () => {
  test('a valid job is queued with defaults filled in', async () => {
    const { majo, scene } = await setup();
    const res = await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      type: 'render', state: 'queued', priority: 'normal', params: { frame_start: 1, samples: 128 }, inputs: { scene }, position: 1, type_unavailable: false,
    });
  });

  test('a file is input of one job only', async () => {
    const { majo, scene } = await setup();
    await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    expect((await submit(majo, { type: 'render', params: { frame_start: 2 }, inputs: { scene } })).statusCode).toBe(409);
  });

  test('unknown or withdrawn types, bad params, missing or wrong inputs are 422', async () => {
    const { majo, scene } = await setup();
    const wav = await uploadFile(t.app, majo, 'a.wav', 'RIFF');
    expect((await submit(majo, { type: 'upscale', params: {}, inputs: {} })).statusCode).toBe(422);
    const bad = await submit(majo, { type: 'render', params: { frame_start: -1 }, inputs: { scene } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toContain('frame_start');
    expect((await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: {} })).statusCode).toBe(422);
    expect((await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene: wav } })).statusCode).toBe(422);
    expect((await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene, extra: wav } })).statusCode).toBe(422);
    announce(t.db, [transcribeContract], t.clock.now);
    expect((await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).statusCode).toBe(422);
  });

  test("another client's file is 404", async () => {
    const { eve, scene } = await setup();
    expect((await submit(eve, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).statusCode).toBe(404);
  });

  test('priority orders the queue position', async () => {
    const { majo, scene } = await setup();
    const other = await uploadFile(t.app, majo, 'b.blend', 'B');
    await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    const high = await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene: other }, priority: 'high' });
    expect(high.json().position).toBe(1);
  });
});

describe('read and cancel', () => {
  test('clients see only their own jobs', async () => {
    const { majo, eve, scene } = await setup();
    const id = (await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene }, group: 'anim-1' })).json().id;
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs', headers: h(majo) })).json().jobs).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs?group=anim-1', headers: h(majo) })).json().jobs).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs', headers: h(eve) })).json().jobs).toHaveLength(0);
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: h(eve) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: h(eve) })).statusCode).toBe(404);
  });

  test('cancel a queued job; cancelling again is 409', async () => {
    const { majo, scene } = await setup();
    const id = (await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).json().id;
    const res = await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: h(majo) });
    expect(res.json()).toMatchObject({ state: 'canceled', position: null });
    expect((await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: h(majo) })).statusCode).toBe(409);
  });

  test('a queued job of a withdrawn type is flagged', async () => {
    const { majo, scene } = await setup();
    const id = (await submit(majo, { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).json().id;
    announce(t.db, [transcribeContract], t.clock.now);
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: h(majo) })).json()).toMatchObject({ state: 'queued', type_unavailable: true });
  });
});
