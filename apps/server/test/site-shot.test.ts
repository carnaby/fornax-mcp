// Not a test: the result page image of the landing page (spec 2026-11-19), from an invented render job on a test
// server. Skipped unless FORNAX_SITE_SHOT=1; it uses the browser of scripts/site-shots.mjs.
// Run: FORNAX_SITE_SHOT=1 pnpm --filter @fornax/server exec vitest run test/site-shot.test.ts
import { eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { IMG, shot } from '../../../scripts/site-shots.mjs';
import { jobs } from '../src/db/schema.js';
import { FileStore } from '../src/files/store.js';
import { resultPath } from '../src/http/links.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** An invented frame: a dusk sky, a sun and two hills. */
const FRAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2a4a"/><stop offset="1" stop-color="#e8622c"/></linearGradient></defs>
  <rect width="1920" height="1080" fill="url(#sky)"/>
  <circle cx="1280" cy="640" r="150" fill="#f5b04a"/>
  <path d="M0 760 Q 480 560 960 740 T 1920 700 V 1080 H 0 Z" fill="#2b2130"/>
  <path d="M0 900 Q 600 760 1200 880 T 1920 860 V 1080 H 0 Z" fill="#161219"/>
</svg>`;

const LOG = [
  'Read blend: scene_04.blend',
  'Fra:1 Mem:412.20M | Rendering 1 / 128 samples',
  'Fra:1 Mem:412.20M | Rendering 64 / 128 samples',
  'Fra:1 Mem:412.20M | Rendering 128 / 128 samples',
  'Saved: frame_0001.png',
  'Time: 03:12.40 (Saving: 00:00.21)',
  '',
].join('\n');

test.skipIf(!process.env.FORNAX_SITE_SHOT)('the result page of an invented render job', async () => {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene_04.blend', 'B');
  const submit = await t.app.inject({
    method: 'POST', url: '/api/jobs', headers: bearer(alice),
    payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene }, agent: 'agent-station' },
  });
  expect(submit.statusCode).toBe(201);
  const id = submit.json().id as string;
  const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json().lease as string;
  t.clock.advance(192_000);
  const put = async (name: string, body: string | Buffer, kind = 'output') => {
    const res = await t.app.inject({
      method: 'PUT', url: `/api/worker/jobs/${id}/outputs/${name}?kind=${kind}`,
      headers: { ...bearer(worker), 'content-type': 'application/octet-stream', 'x-fornax-lease': lease }, payload: body,
    });
    expect(res.statusCode, name).toBe(201);
  };
  await put('frame_0001.png', await sharp(Buffer.from(FRAME_SVG)).png().toBuffer());
  await put('log.txt', LOG, 'log');
  const done = await t.app.inject({
    method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: bearer(worker),
    payload: { lease, outputs: { 'frame_0001.png': { meta: { frame: 1, samples: 128 } } } },
  });
  expect(done.statusCode).toBeLessThan(300);
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = t.app.server.address() as AddressInfo;
  const row = t.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
  const deps = { config: t.config, db: t.db, store: new FileStore(t.config.filesDir), clock: () => t.clock.now };
  await shot(`http://127.0.0.1:${port}${resultPath(deps, row)}`, 992, 1100, join(IMG, 'result.webp'));
}, 180_000);
