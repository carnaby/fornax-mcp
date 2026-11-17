import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { rmSync } from 'node:fs';
import { files as filesTable, jobs } from '../src/db/schema.js';
import { revokeToken } from '../src/domain/tokens.js';
import { FileStore } from '../src/files/store.js';
import { resultPath } from '../src/http/links.js';
import { sign } from '../src/http/signing.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, TEST_SECRET, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const deps = () => ({ config: t.config, db: t.db, store: new FileStore(t.config.filesDir), clock: () => t.clock.now });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const open = (id: string) => t.app.inject({ method: 'GET', url: resultPath(deps(), t.db.select().from(jobs).where(eq(jobs.id, id)).get()!) });
const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/** Alice and the worker; start() submits one render job and claims it, with helpers for what the worker does next. */
async function actors() {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  async function start() {
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const id = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } })).json().id as string;
    const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json().lease as string;
    const call = (path: string, payload: object) => t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/${path}`, headers: bearer(worker), payload: { lease, ...payload } });
    return {
      id,
      put: async (name: string, body: string | Buffer, kind = 'output') => {
        const res = await t.app.inject({
          method: 'PUT', url: `/api/worker/jobs/${id}/outputs/${name}?kind=${kind}`,
          headers: { ...bearer(worker), 'content-type': 'application/octet-stream', 'x-fornax-lease': lease }, payload: body,
        });
        expect(res.statusCode, name).toBe(201);
      },
      heartbeat: (progress: number, message: string) => call('heartbeat', { progress, message }),
      complete: (outputs: object = {}) => call('complete', { outputs }),
      fail: (error: string) => call('fail', { error, permanent: true }),
    };
  }
  return { alice, start };
}

describe('the result page', () => {
  test('its headers, and a refresh only while the job is queued or running', async () => {
    const job = await (await actors()).start();
    await job.heartbeat(0.4, 'frame 2/5');
    const page = await open(job.id);
    expect(page.statusCode).toBe(200);
    expect(page.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
    });
    expect(page.body).toContain('<meta http-equiv="refresh" content="5">');
    expect(page.body).toContain('value="40"');
    expect(page.body).toContain('frame 2/5');
    expect(page.body).not.toContain('<script');
    await job.complete();
    const done = (await open(job.id)).body;
    expect(done).not.toContain('http-equiv="refresh"');
    expect(done).toContain('succeeded');
  });

  test('outputs: the preview linked to the original, players, text inline, the log; every link works without a token', async () => {
    const job = await (await actors()).start();
    const png = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    await job.put('frame.png', png);
    await job.put('talk.wav', 'RIFF');
    await job.put('clip.mp4', 'MP4');
    await job.put('result.json', '{"a":1}');
    await job.put('log.txt', 'all good', 'log');
    await job.complete({ 'frame.png': { meta: { width: 2048 } } });
    const body = (await open(job.id)).body;
    const img = /<img src="([^"]+)" alt="frame.png" loading="lazy">/.exec(body)?.[1]?.replaceAll('&amp;', '&');
    expect(img).toMatch(new RegExp(`^/api/jobs/${job.id}/outputs/\\.fornax/previews/frame\\.png\\.jpg\\?sig=`));
    expect((await t.app.inject({ method: 'GET', url: img! })).headers['content-type']).toBe('image/jpeg');
    expect(body).toMatch(/<audio controls preload="none" src="\/api\/jobs\/[^"]+\/outputs\/talk\.wav\?sig=[^"]+"><\/audio>/);
    expect(body).toMatch(/<video controls preload="metadata" src="\/api\/jobs\/[^"]+\/outputs\/clip\.mp4\?sig=[^"]+"><\/video>/);
    expect(body).toContain('<pre>{\n  &quot;a&quot;: 1\n}</pre>');
    expect(body).toContain('width: 2048');
    expect(body).toContain('<pre>all good</pre>');
    const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&'));
    // frame.png (download + the preview's link), talk.wav, clip.mp4, result.json, the log
    expect(hrefs.length).toBe(6);
    for (const href of hrefs) expect((await t.app.inject({ method: 'GET', url: href })).statusCode, href).toBe(200);
  });

  test('every string a client or a tool controls is escaped', async () => {
    const { start } = await actors();
    const ok = await start();
    await ok.heartbeat(0.1, '<b>bold</b>');
    expect((await open(ok.id)).body).toContain('&lt;b&gt;bold&lt;/b&gt;');
    await ok.put('notes.txt', '</pre><script>alert(1)</script>');
    await ok.put('data.json', '{"x":"<img src=x onerror=alert(2)>"}');
    await ok.complete({ 'notes.txt': { meta: { note: '<i>m</i>' } } });
    const okBody = (await open(ok.id)).body;
    expect(okBody).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(okBody).not.toMatch(/<script|<img src=x|<i>|<b>/);

    const bad = await start();
    await bad.put('log.txt', '<img src=x onerror=alert(4)>', 'log');
    await bad.fail('<script>alert(3)</script>');
    const badBody = (await open(bad.id)).body;
    expect(badBody).toContain('&lt;script&gt;alert(3)&lt;/script&gt;');
    expect(badBody).toContain('&lt;img src=x onerror=alert(4)&gt;');
    expect(badBody).not.toMatch(/<script|<img src=x/);
  });

  test('hostile strings in every rendered field stay text', async () => {
    const { start } = await actors();
    const job = await start();
    const hostile = '"><img src=x onerror=alert(5)> javascript:alert(6) \u202eevil';
    await job.heartbeat(0.5, hostile);
    const running = (await open(job.id)).body;
    expect(running).not.toMatch(/<img|<script/);
    expect(running).toContain('&quot;&gt;&lt;img src=x onerror=alert(5)&gt;');
    expect(running).not.toContain('\u202e');
    expect(running).toContain('U+202E');
    await job.put('notes.txt', hostile);
    await job.put('data.json', JSON.stringify({ k: '</pre><script>alert(7)</script>', '"><svg onload=1>': 1 }));
    await job.complete({ 'notes.txt': { meta: { [hostile]: hostile, n: 1 } }, 'data.json': { meta: { link: 'javascript:alert(8)' } } });
    const body = (await open(job.id)).body;
    expect(body).not.toMatch(/<img|<svg|<script/);
    expect(body).not.toContain('\u202e');
    // Attribute values and every tag on the page come from the template, never from a client.
    const tags = [...body.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'h1', 'span', 'p', 'h2', 'section', 'h3', 'a', 'pre']));
    expect(body).not.toMatch(/href="javascript:|src="javascript:/);
  });

  test('a file gone from disk leaves the page up', async () => {
    const job = await (await actors()).start();
    await job.put('notes.txt', 'hello');
    await job.put('log.txt', 'logged', 'log');
    await job.put('other.txt', 'kept');
    await job.complete();
    const files = t.db.select().from(filesTable).where(eq(filesTable.jobId, job.id)).all();
    for (const f of files.filter((x) => x.name === 'notes.txt' || x.name === 'log.txt')) rmSync(new FileStore(t.config.filesDir).pathOf(f.id));
    const page = await open(job.id);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('other.txt');
  });

  test('a long log shows its last 100 kB, cut on a character boundary', async () => {
    const job = await (await actors()).start();
    // 60 000 two-byte characters and one byte more: the 100 kB cut falls inside a character.
    await job.put('log.txt', `START${'é'.repeat(60_000)}END`, 'log');
    await job.complete();
    const body = (await open(job.id)).body;
    expect(body).toContain('The last 100 kB');
    expect(body).toContain('END</pre>');
    expect(body).not.toContain('START');
    expect(body).not.toContain('�');
  });

  test('invalid, tampered, expired and other-purpose links get the same 404 page', async () => {
    const job = await (await actors()).start();
    await job.complete();
    const good = resultPath(deps(), t.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!);
    const pages = [];
    for (const url of ['/r/nonsense', `${good}x`, `/r/${sign(TEST_SECRET, 'download', job.id, new Date(t.clock.now.getTime() + 60_000))}`]) {
      pages.push(await t.app.inject({ method: 'GET', url }));
    }
    t.clock.advance(t.config.retention.finishedMs + 1000);
    pages.push(await t.app.inject({ method: 'GET', url: good }));
    for (const p of pages) {
      expect(p.statusCode).toBe(404);
      expect(p.headers['content-security-policy']).toBe(CSP);
      expect(p.body).not.toContain(job.id);
    }
    expect(new Set(pages.map((p) => p.body)).size).toBe(1);
    expect(pages[0]!.body).toContain('This link is not valid or has expired.');
  });

  test("a revoked owner's page is gone", async () => {
    const job = await (await actors()).start();
    await job.complete();
    revokeToken(t.db, 'alice');
    expect((await open(job.id)).statusCode).toBe(404);
  });
});

describe('final review 07 #6', () => {
  test('an idle job says why it does not start', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
    const id = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene }, priority: 'idle' } })).json().id as string;
    const page = await open(id);
    expect(page.body).toContain('This job is idle: it waits until the operator starts it or its owner changes its priority.');
    expect(page.body).not.toContain('Place in the queue');
  });
});
