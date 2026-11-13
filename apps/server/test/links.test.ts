import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { jobs } from '../src/db/schema.js';
import { jobFile } from '../src/domain/outputs.js';
import { revokeToken } from '../src/domain/tokens.js';
import { FileStore } from '../src/files/store.js';
import { downloadPath, jobOfResultLink, resultLinkExpiry, resultPath, resultUrl } from '../src/http/links.js';
import { sign } from '../src/http/signing.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, TEST_SECRET, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const deps = () => ({ config: t.config, db: t.db, store: new FileStore(t.config.filesDir), clock: () => t.clock.now });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const job = (id: string) => t.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });
const pathOf = (id: string, name: string) => downloadPath(deps(), job(id), jobFile(t.db, id, name)!).path;
const sigOf = (path: string) => new URL(path, 'http://x').searchParams.get('sig')!;

/** A succeeded job of `owner` with outputs a.txt ("A") and b.txt ("B"). */
async function done(owner: string) {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, `pc${owner}`, 'worker');
  const token = issueToken(t.db, owner);
  const scene = await uploadFile(t.app, token, 'scene.blend', 'S');
  const id = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(token), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } })).json().id as string;
  const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json().lease as string;
  for (const [name, body] of [['a.txt', 'A'], ['b.txt', 'B']] as const) {
    await t.app.inject({
      method: 'PUT', url: `/api/worker/jobs/${id}/outputs/${name}`,
      headers: { ...bearer(worker), 'content-type': 'application/octet-stream', 'x-fornax-lease': lease }, payload: body,
    });
  }
  await t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: bearer(worker), payload: { lease } });
  return { token, id };
}

describe('download links', () => {
  test('a signed link downloads without a token', async () => {
    const { id } = await done('alice');
    const res = await get(pathOf(id, 'a.txt'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('A');
  });

  test('a link is bound to its purpose, its job and its file', async () => {
    const a = await done('alice');
    const b = await done('bob');
    const sigA = sigOf(pathOf(a.id, 'a.txt'));
    expect((await get(`/api/jobs/${a.id}/outputs/b.txt?sig=${sigA}`)).statusCode).toBe(404);
    expect((await get(`/api/jobs/${b.id}/outputs/a.txt?sig=${sigA}`)).statusCode).toBe(404);
    const payload = `${a.id}:${jobFile(t.db, a.id, 'a.txt')!.id}`;
    const until = new Date(t.clock.now.getTime() + 3_600_000);
    expect((await get(`/api/jobs/${a.id}/outputs/a.txt?sig=${sign(TEST_SECRET, 'result', payload, until)}`)).statusCode).toBe(404);
    expect((await get(`/api/jobs/${a.id}/outputs/a.txt?sig=${sign(TEST_SECRET, 'upload', payload, until)}`)).statusCode).toBe(404);
    expect((await get(`/api/jobs/${a.id}/outputs/a.txt?sig=${sign(TEST_SECRET, 'download', payload, until)}`)).statusCode).toBe(200);
  });

  test('a link lasts 24 hours', async () => {
    const { id } = await done('alice');
    const path = pathOf(id, 'a.txt');
    t.clock.advance(86_400_000 - 1000);
    expect((await get(path)).statusCode).toBe(200);
    t.clock.advance(1000);
    expect((await get(path)).statusCode).toBe(404);
  });

  test('a link stops working when its owner token is revoked', async () => {
    const { id } = await done('alice');
    const path = pathOf(id, 'a.txt');
    revokeToken(t.db, 'alice');
    expect((await get(path)).statusCode).toBe(404);
  });

  test('with a token the owner check applies; with neither token nor link it is 401', async () => {
    const a = await done('alice');
    const eve = issueToken(t.db, 'eve');
    expect((await get(pathOf(a.id, 'a.txt'), bearer(eve))).statusCode).toBe(404);
    expect((await get(`/api/jobs/${a.id}/outputs/a.txt`)).statusCode).toBe(401);
    expect((await get(`/api/jobs/${a.id}/outputs/a.txt`, bearer(a.token))).body).toBe('A');
  });
});

describe('result links', () => {
  test('a result link opens its job, and only as a result link', async () => {
    const a = await done('alice');
    const signed = resultPath(deps(), job(a.id)).slice('/r/'.length);
    expect(signed).toMatch(new RegExp(`^${a.id}\\.\\d+\\.[A-Za-z0-9_-]+$`));
    expect(jobOfResultLink(deps(), signed)?.id).toBe(a.id);
    expect(jobOfResultLink(deps(), `${signed}x`)).toBeNull();
    expect(jobOfResultLink(deps(), sign(TEST_SECRET, 'download', a.id, new Date(t.clock.now.getTime() + 60_000)))).toBeNull();
    expect(resultUrl(deps(), job(a.id))).toBe(`https://fornax.example.com/r/${signed}`);
  });

  test("a finished job's link lasts until its retention ends; an unfinished job's for the retention from now", async () => {
    const a = await done('alice');
    const finished = job(a.id);
    expect(resultLinkExpiry(t.config, finished, t.clock.now).getTime()).toBe(finished.finishedAt!.getTime() + t.config.retention.finishedMs);
    const unfinished = { ...finished, state: 'queued' as const, finishedAt: null };
    expect(resultLinkExpiry(t.config, unfinished, t.clock.now).getTime()).toBe(t.clock.now.getTime() + t.config.retention.finishedMs);
    const signed = resultPath(deps(), finished).slice('/r/'.length);
    t.clock.advance(t.config.retention.finishedMs + 1000);
    expect(jobOfResultLink(deps(), signed)).toBeNull();
  });

  test('a revoked owner closes the result link', async () => {
    const a = await done('alice');
    const signed = resultPath(deps(), job(a.id)).slice('/r/'.length);
    revokeToken(t.db, 'alice');
    expect(jobOfResultLink(deps(), signed)).toBeNull();
  });
});
