import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { files, jobs } from '../src/db/schema.js';
import { resultPath } from '../src/http/links.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';
import { bearerHeader, callJson, useMcp } from './mcp-helpers.js';

const t = useTestApp({ limits: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxQueuedPerToken: 50 } });
const mcp = useMcp(() => t.app);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const dir = mkdtempSync(join(tmpdir(), 'fornax-archive-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Alice's render job, claimed, with these files uploaded by the worker; `complete()` finishes it. */
async function jobWith(uploads: Array<[name: string, body: string, kind?: 'output' | 'log']>) {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  const id = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } })).json().id as string;
  const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json().lease as string;
  for (const [name, body, kind = 'output'] of uploads) {
    const res = await t.app.inject({
      method: 'PUT', url: `/api/worker/jobs/${id}/outputs/${name}?kind=${kind}`,
      headers: { ...bearer(worker), 'content-type': 'application/octet-stream', 'x-fornax-lease': lease }, payload: body,
    });
    expect(res.statusCode, name).toBe(201);
  }
  const complete = () => t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: bearer(worker), payload: { lease, outputs: {} } });
  const getJob = async () => callJson(await mcp.connect('/mcp', bearerHeader(alice)), 'get_job', { job_id: id });
  return { alice, id, complete, getJob };
}
const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/** unzip (Linux CI) or the Windows tar.exe lists the archive; null when neither is there. */
function listZip(bytes: Buffer): string[] | null {
  const path = join(dir, `a-${Date.now()}-${Math.random()}.zip`);
  writeFileSync(path, bytes);
  if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0) {
    execFileSync('unzip', ['-tq', path]);
    return execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  const root = process.env.SystemRoot;
  const tar = process.platform === 'win32' && root ? join(root, 'System32', 'tar.exe') : null;
  return tar && existsSync(tar) ? execFileSync(tar, ['-tf', path], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean) : null;
}

describe('the archive of a job (spec 14 § 4)', () => {
  test('archive_url is null until there are outputs; then a ZIP of the outputs and the log', async () => {
    const job = await jobWith([['frame_0001.png', 'P1'], ['frame_0002.png', 'P2'], ['log.txt', 'all good', 'log']]);
    expect((await job.getJob()).archive_url).toBeNull();
    await job.complete();
    const view = await job.getJob();
    expect(view.archive_url).toMatch(new RegExp(`^https://fornax\\.example\\.com/api/jobs/${job.id}/archive\\.zip\\?sig=`));
    const res = await t.app.inject({ method: 'GET', url: pathOf(view.archive_url) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="render-${job.id}.zip"`);
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    const names = listZip(res.rawPayload);
    if (names) {
      expect(names.at(-1)).toBe('log.txt');
      expect(names.slice(0, -1).sort()).toEqual(['frame_0001.png', 'frame_0002.png']);
      expect(names.some((n) => n.startsWith('.fornax/') || n.startsWith('previews/'))).toBe(false);
    }
  });

  test("a wrong or another job's signature is a 404", async () => {
    const a = await jobWith([['a.txt', 'A']]);
    await a.complete();
    const b = await jobWith([['b.txt', 'B']]);
    await b.complete();
    const urlA = new URL((await a.getJob()).archive_url);
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${b.id}/archive.zip${urlA.search}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${a.id}/archive.zip?sig=nope` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${a.id}/archive.zip` })).statusCode).toBe(404);
  });

  test('a missing disk file is a 404 before anything is sent', async () => {
    const job = await jobWith([['a.txt', 'A'], ['b.txt', 'B']]);
    await job.complete();
    const url = (await job.getJob()).archive_url;
    const row = t.db.select().from(files).where(eq(files.name, 'b.txt')).get()!;
    rmSync(join(t.config.filesDir, row.id));
    const res = await t.app.inject({ method: 'GET', url: pathOf(url) });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('an output is no longer on the server');
  });

  test('the result page links the archive', async () => {
    const job = await jobWith([['a.txt', 'A']]);
    await job.complete();
    const deps = { config: t.config, db: t.db, clock: () => t.clock.now } as Parameters<typeof resultPath>[0];
    const page = await t.app.inject({ method: 'GET', url: resultPath(deps, t.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!) });
    expect(page.body).toContain('Download all (.zip)');
    expect(page.body).toContain(`/api/jobs/${job.id}/archive.zip?sig=`);
  });
});
