import { expect, test } from 'vitest';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp({
  limits: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxQueuedPerToken: 1 },
  webhooks: { allowedPrefixes: ['https://app.example.com/hooks/'] },
});

test('queued jobs per token are limited', async () => {
  announce(t.db, [renderContract], t.clock.now);
  const majo = issueToken(t.db, 'majo');
  const a = await uploadFile(t.app, majo, 'a.blend', 'A');
  const b = await uploadFile(t.app, majo, 'b.blend', 'B');
  const h = { authorization: `Bearer ${majo}` };
  expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene: a } } })).statusCode).toBe(201);
  expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene: b } } })).statusCode).toBe(429);
});

test('callback_url must match an allowed prefix', async () => {
  announce(t.db, [renderContract], t.clock.now);
  const majo = issueToken(t.db, 'majo');
  const a = await uploadFile(t.app, majo, 'a.blend', 'A');
  const h = { authorization: `Bearer ${majo}` };
  const job = (callback_url: string) => ({ type: 'render', params: { frame_start: 1 }, inputs: { scene: a }, callback_url });
  for (const bad of ['http://169.254.169.254/latest', 'https://app.example.com/other', 'https://app.example.com.evil.test/hooks/x']) {
    expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: job(bad) })).statusCode).toBe(422);
  }
  expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: job('https://app.example.com/hooks/fornax') })).statusCode).toBe(201);
});
