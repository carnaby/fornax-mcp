import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { jobs } from '../src/db/schema.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp({
  limits: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxQueuedPerToken: 1 },
  webhooks: { allowedPrefixes: ['https://app.example.com/hooks/'] },
});

test('queued jobs per token are limited', async () => {
  announce(t.db, [renderContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  const a = await uploadFile(t.app, alice, 'a.blend', 'A');
  const b = await uploadFile(t.app, alice, 'b.blend', 'B');
  const h = { authorization: `Bearer ${alice}` };
  expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene: a } } })).statusCode).toBe(201);
  expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene: b } } })).statusCode).toBe(429);
});

test('callback_url must match an allowed prefix', async () => {
  announce(t.db, [renderContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  const a = await uploadFile(t.app, alice, 'a.blend', 'A');
  const h = { authorization: `Bearer ${alice}` };
  const job = (callback_url: string) => ({ type: 'render', params: { frame_start: 1 }, inputs: { scene: a }, callback_url });
  for (const bad of ['http://169.254.169.254/latest', 'https://app.example.com/other', 'https://app.example.com.evil.test/hooks/x', 'https://app.example.com@evil.test/hooks/x', 'https://app.example.com/hooks/../x', 'https://app.example.com/hooks/%2e%2e/x']) {
    expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: job(bad) })).statusCode).toBe(422);
  }
  expect((await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: job('https://app.example.com/hooks/fornax') })).statusCode).toBe(201);
});

test('the stored callback is the normalized URL that was validated', async () => {
  announce(t.db, [renderContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  const a = await uploadFile(t.app, alice, 'a.blend', 'A');
  const h = { authorization: `Bearer ${alice}` };
  const res = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: h, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene: a }, callback_url: 'https://APP.example.com/hooks/a' } });
  expect(res.statusCode).toBe(201);
  expect(t.db.select().from(jobs).where(eq(jobs.id, res.json().id)).get()?.callbackUrl).toBe('https://app.example.com/hooks/a');
});
