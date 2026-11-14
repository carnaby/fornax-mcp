import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { webhookKey } from '@fornax/protocol';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { webhookDeliveries } from '../src/db/schema.js';
import { runMaintenance } from '../src/domain/maintenance.js';
import { revokeToken } from '../src/domain/tokens.js';
import { deliverWebhooks, startWebhookLoop, WEBHOOK_TIMEOUT_MS } from '../src/domain/webhooks.js';
import { FileStore } from '../src/files/store.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

type Hit = { url: string; headers: IncomingHttpHeaders; body: string };
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

/** A webhook receiver on 127.0.0.1 that records every request; `answer` decides the reply (null: never answer). */
async function receiver(answer: (hit: Hit) => { status: number; headers?: Record<string, string> } | null = () => ({ status: 204 })) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
    });
    req.on('end', () => {
      const hit = { url: req.url ?? '', headers: req.headers, body };
      hits.push(hit);
      const a = answer(hit);
      if (a) res.writeHead(a.status, a.headers).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

const lines: string[] = [];
beforeEach(() => {
  lines.splice(0);
});
const log = {
  info: (o: object, m: string) => void lines.push(`${m} ${JSON.stringify(o)}`),
  error: (o: object, m: string) => void lines.push(`${m} ${JSON.stringify(o)}`),
};
const deps = () => ({ config: t.config, db: t.db, clock: () => t.clock.now });
const deliver = (opts: { timeoutMs?: number } = {}) => deliverWebhooks(deps(), log, opts);
const deliveries = () => t.db.select().from(webhookDeliveries).orderBy(webhookDeliveries.createdAt).all();

/** Alice's render job with a callback under the receiver's /hooks/, canceled at once: that queues its webhook. */
async function canceledJob(base: string, path = '/hooks/fornax') {
  t.config.webhooks = { allowedPrefixes: [`${base}/hooks/`] };
  announce(t.db, [renderContract], t.clock.now);
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  const res = await t.app.inject({
    method: 'POST', url: '/api/jobs', headers: bearer(alice),
    payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene }, callback_url: `${base}${path}` },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: bearer(alice) });
  return { alice, id };
}

describe('webhook deliveries', () => {
  test('a final state queues one delivery, signed with the key the client derives from its own token', async () => {
    const r = await receiver();
    const { alice, id } = await canceledJob(r.url);
    expect(deliveries()).toMatchObject([{ jobId: id, status: 'pending', attempt: 0 }]);
    expect(await deliver()).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(r.hits).toHaveLength(1);
    const hit = r.hits[0]!;
    expect(hit.url).toBe('/hooks/fornax');
    expect(hit.headers['content-type']).toBe('application/json');
    expect(JSON.parse(hit.body)).toEqual({ job_id: id, state: 'canceled' });
    const ts = hit.headers['x-fornax-timestamp'];
    expect(ts).toBe(String(Math.floor(t.clock.now.getTime() / 1000)));
    expect(hit.headers['x-fornax-signature']).toBe(`sha256=${createHmac('sha256', webhookKey(alice)).update(`${ts}.${hit.body}`).digest('hex')}`);
    expect(deliveries()).toMatchObject([{ status: 'sent', attempt: 1, lastError: null }]);
    expect(await deliver()).toEqual({ sent: 0, retrying: 0, failed: 0 });
  });

  test('succeeded and failed jobs queue one too; a retried attempt does not', async () => {
    const r = await receiver();
    t.config.webhooks = { allowedPrefixes: [`${r.url}/hooks/`] };
    announce(t.db, [renderContract], t.clock.now);
    const worker = issueToken(t.db, 'pc', 'worker');
    const alice = issueToken(t.db, 'alice');
    const submit = async () => {
      const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
      const payload = { type: 'render', params: { frame_start: 1 }, inputs: { scene }, callback_url: `${r.url}/hooks/x` };
      return (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload })).json().id as string;
    };
    const claim = async () => (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json() as { id: string; lease: string };
    const worker_ = (c: { id: string; lease: string }, path: string, extra: object = {}) =>
      t.app.inject({ method: 'POST', url: `/api/worker/jobs/${c.id}/${path}`, headers: bearer(worker), payload: { lease: c.lease, ...extra } });

    const ok = await submit();
    await worker_(await claim(), 'complete');
    const bad = await submit();
    await worker_(await claim(), 'fail', { error: 'oom' });
    expect(deliveries().map((d) => d.jobId)).toEqual([ok]);
    t.clock.advance(60_000);
    await worker_(await claim(), 'fail', { error: 'bad input', permanent: true });
    expect(deliveries().map((d) => JSON.parse(d.payload))).toEqual([{ job_id: ok, state: 'succeeded' }, { job_id: bad, state: 'failed' }]);
  });

  test('a failing receiver is tried at once, 1 minute later and 5 minutes after that; then it is given up', async () => {
    const r = await receiver(() => ({ status: 500 }));
    await canceledJob(r.url);
    expect(await deliver()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect(deliveries()[0]).toMatchObject({ status: 'pending', attempt: 1, lastError: 'HTTP 500' });
    t.clock.advance(59_999);
    expect(await deliver()).toEqual({ sent: 0, retrying: 0, failed: 0 });
    t.clock.advance(1);
    expect(await deliver()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    t.clock.advance(299_999);
    expect(await deliver()).toEqual({ sent: 0, retrying: 0, failed: 0 });
    t.clock.advance(1);
    expect(await deliver()).toEqual({ sent: 0, retrying: 0, failed: 1 });
    expect(r.hits).toHaveLength(3);
    expect(deliveries()[0]).toMatchObject({ status: 'failed', attempt: 3, lastError: 'HTTP 500' });
  });

  test('a redirect is a failure and is never followed', async () => {
    const r = await receiver((hit) => (hit.url === '/hooks/fornax' ? { status: 302, headers: { location: '/internal/admin' } } : { status: 204 }));
    await canceledJob(r.url);
    expect(await deliver()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect(r.hits.map((h) => h.url)).toEqual(['/hooks/fornax']);
    expect(deliveries()[0]).toMatchObject({ status: 'pending', lastError: 'HTTP 302' });
  });

  test('a prefix removed from the config stops a queued delivery without sending it', async () => {
    const r = await receiver();
    await canceledJob(r.url);
    t.config.webhooks = { allowedPrefixes: [] };
    expect(await deliver()).toEqual({ sent: 0, retrying: 0, failed: 1 });
    expect(r.hits).toEqual([]);
    expect(deliveries()[0]).toMatchObject({ status: 'failed', lastError: 'callback_url is no longer allowed' });
  });

  test('a revoked owner gets no delivery', async () => {
    const r = await receiver();
    await canceledJob(r.url);
    revokeToken(t.db, 'alice');
    expect(await deliver()).toEqual({ sent: 0, retrying: 0, failed: 1 });
    expect(r.hits).toEqual([]);
    expect(deliveries()[0]).toMatchObject({ status: 'failed', lastError: 'the owner token is not active' });
  });

  test('a receiver that does not answer runs into the timeout', async () => {
    const r = await receiver(() => null);
    await canceledJob(r.url);
    expect(await deliver({ timeoutMs: 200 })).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect(deliveries()[0]).toMatchObject({ status: 'pending', lastError: 'timeout' });
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
  });

  test('the log holds ids and the status code, never the URL or the body', async () => {
    const r = await receiver(() => ({ status: 500 }));
    const { id } = await canceledJob(r.url, '/hooks/fornax?key=SECRETQ');
    await deliver();
    const out = lines.join('\n');
    expect(out).toContain(id);
    expect(out).toContain('500');
    expect(out).not.toMatch(/SECRETQ|\/hooks\/|127\.0\.0\.1|"state"/);
  });

  test('the loop sends on its own and stops cleanly', async () => {
    const r = await receiver();
    await canceledJob(r.url);
    const loop = startWebhookLoop(deps(), log, 20);
    try {
      for (let i = 0; i < 200 && r.hits.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await loop.stop();
    }
    expect(r.hits).toHaveLength(1);
    expect(deliveries()[0]).toMatchObject({ status: 'sent' });
  });

  test('deliveries go with their job at the end of its retention', async () => {
    const r = await receiver();
    await canceledJob(r.url);
    t.clock.advance(t.config.retention.finishedMs + 1);
    await runMaintenance({ ...deps(), store: new FileStore(t.config.filesDir) });
    expect(deliveries()).toEqual([]);
  });
});

test('stop() aborts a hanging delivery without counting the attempt', async () => {
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  // A receiver that never answers.
  const receiver = createServer(() => arrived());
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hooks/`;
  t.config.webhooks.allowedPrefixes = [url];
  try {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const id = (
      await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene }, callback_url: `${url}job` } })
    ).json().id as string;
    await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: { authorization: `Bearer ${alice}` } });
    const loop = startWebhookLoop({ config: t.config, db: t.db, clock: () => t.clock.now }, { info: () => undefined, error: () => undefined }, 20);
    await reached;
    const started = Date.now();
    await loop.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.db.select().from(webhookDeliveries).get()).toMatchObject({ status: 'pending', attempt: 0 });
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});
