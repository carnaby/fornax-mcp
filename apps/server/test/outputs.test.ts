import { describe, expect, test } from 'vitest';
import { files, jobs } from '../src/db/schema.js';
import { FileStore } from '../src/files/store.js';
import { buildApp } from '../src/http/app.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const w = (token: string, lease?: string) => ({
  authorization: `Bearer ${token}`, 'x-fornax-worker': 'gpu-pc', 'content-type': 'application/octet-stream', ...(lease ? { 'x-fornax-lease': lease } : {}),
});

async function running() {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const eve = issueToken(t.db, 'eve');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  const id = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` }, payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } })).json().id as string;
  const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${worker}` }, payload: { wait: 0 } })).json().lease as string;
  const put = (name: string, body: string | Buffer, kind = 'output', l = lease) =>
    t.app.inject({ method: 'PUT', url: `/api/worker/jobs/${id}/outputs/${name}?kind=${kind}`, headers: w(worker, l), payload: body });
  const complete = (outputs: object, l = lease) =>
    t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: { authorization: `Bearer ${worker}` }, payload: { lease: l, outputs } });
  return { worker, alice, eve, id, lease, put, complete };
}

describe('outputs', () => {
  test('upload, complete, manifest, download', async () => {
    const r = await running();
    expect((await r.put('frame_0001.png', 'PNG1')).statusCode).toBe(201);
    expect((await r.put('previews/frame_0001.jpg', 'JPG1')).statusCode).toBe(201);
    expect((await r.put('log.txt', 'line 1', 'log')).statusCode).toBe(201);
    const done = await r.complete({ 'frame_0001.png': { meta: { width: 2 }, preview: 'previews/frame_0001.jpg' } });
    expect(done.statusCode).toBe(200);

    const job = (await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}`, headers: { authorization: `Bearer ${r.alice}` } })).json();
    expect(job).toMatchObject({ state: 'succeeded', progress: 1, log: 'log.txt' });
    expect(job.outputs).toEqual([
      { name: 'frame_0001.png', mime: 'image/png', size: 4, sha256: expect.any(String), meta: { width: 2 }, preview: 'previews/frame_0001.jpg' },
    ]);

    const png = await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}/outputs/frame_0001.png`, headers: { authorization: `Bearer ${r.alice}` } });
    expect(png.body).toBe('PNG1');
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}/outputs/previews/frame_0001.jpg`, headers: { authorization: `Bearer ${r.alice}` } })).body).toBe('JPG1');
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}/outputs/frame_0001.png`, headers: { authorization: `Bearer ${r.eve}` } })).statusCode).toBe(404);
  });

  test('outputs without metadata are listed too', async () => {
    const r = await running();
    await r.put('out.txt', 'x');
    await r.complete({});
    const job = (await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}`, headers: { authorization: `Bearer ${r.alice}` } })).json();
    expect(job.outputs).toEqual([{ name: 'out.txt', mime: 'text/plain', size: 1, sha256: expect.any(String), meta: null, preview: null }]);
  });

  test('bad names are 400; over the job limit is 413', async () => {
    const r = await running();
    expect((await r.put('.hidden', 'x')).statusCode).toBe(400);
    expect((await r.put('a%5Cb', 'x')).statusCode).toBe(400);
    expect((await r.put('big.bin', Buffer.alloc(1024 * 1024 + 1))).statusCode).toBe(413);
    expect(t.db.select().from(files).all().filter((f) => f.jobId === r.id && f.kind !== 'input')).toEqual([]);
  });

  test('uploading the same name again replaces it', async () => {
    const r = await running();
    await r.put('a.txt', 'one');
    await r.put('a.txt', 'three');
    const rows = t.db.select().from(files).all().filter((f) => f.jobId === r.id && f.name === 'a.txt');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.size).toBe(5);
  });

  test('after cancel, uploads and complete are 409', async () => {
    const r = await running();
    await t.app.inject({ method: 'POST', url: `/api/jobs/${r.id}/cancel`, headers: { authorization: `Bearer ${r.alice}` } });
    expect((await r.put('a.txt', 'x')).statusCode).toBe(409);
    expect((await r.complete({})).statusCode).toBe(409);
  });

  test('complete refuses names that were not uploaded', async () => {
    const r = await running();
    await r.put('a.png', 'x');
    expect((await r.complete({ 'b.png': {} })).statusCode).toBe(400);
    expect((await r.complete({ 'a.png': { preview: 'p.jpg' } })).statusCode).toBe(400);
  });

  test('a retried attempt starts clean; a final failure keeps the log', async () => {
    const r = await running();
    await r.put('a.png', 'x');
    await r.put('log.txt', 'try 1', 'log');
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${r.id}/fail`, headers: { authorization: `Bearer ${r.worker}` }, payload: { lease: r.lease, error: 'boom' } });
    expect(t.db.select().from(files).all().filter((f) => f.jobId === r.id && f.kind === 'output')).toEqual([]);
    t.clock.advance(60_000);
    const again = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${r.worker}` }, payload: { wait: 0 } })).json();
    await r.put('log.txt', 'try 2', 'log', again.lease);
    await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${r.id}/fail`, headers: { authorization: `Bearer ${r.worker}` }, payload: { lease: again.lease, error: 'bad input', permanent: true } });
    const job = (await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}`, headers: { authorization: `Bearer ${r.alice}` } })).json();
    expect(job).toMatchObject({ state: 'failed', log: 'log.txt', outputs: [] });
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}/outputs/log.txt`, headers: { authorization: `Bearer ${r.alice}` } })).body).toBe('try 2');
  });

  test('a claim after a lease expired starts without the stale outputs', async () => {
    const r = await running();
    await r.put('stale.png', 'old');
    const claim = () => t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${r.worker}` }, payload: { wait: 0 } });
    t.clock.advance(600_001);
    const again = (await claim()).json(); // the expired lease is released and the job claimed again at once
    expect(again.attempt).toBe(2);
    await r.put('fresh.png', 'new', 'output', again.lease);
    expect((await r.complete({}, again.lease)).statusCode).toBe(200);
    const job = (await t.app.inject({ method: 'GET', url: `/api/jobs/${r.id}`, headers: { authorization: `Bearer ${r.alice}` } })).json();
    expect(job.outputs.map((o: { name: string }) => o.name)).toEqual(['fresh.png']);
    expect(t.db.select().from(files).all().filter((f) => f.jobId === r.id).map((f) => f.name)).not.toContain('stale.png');
  });

  test('a failing discard releases the claimed job: back to queued, attempts unchanged', async () => {
    const r = await running();
    await r.put('stale.png', 'old');
    t.clock.advance(600_001);
    class BrokenStore extends FileStore {
      override async remove(): Promise<void> {
        throw new Error('disk error');
      }
    }
    const broken = await buildApp({ config: t.config, db: t.db, store: new BrokenStore(t.config.filesDir), clock: () => t.clock.now });
    try {
      const res = await broken.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${r.worker}` }, payload: { wait: 0 } });
      expect(res.statusCode).toBe(500);
    } finally {
      await broken.close();
    }
    expect(t.db.select().from(jobs).get()).toMatchObject({ id: r.id, state: 'queued', attempts: 1, leaseExpiresAt: null });
  });
});
