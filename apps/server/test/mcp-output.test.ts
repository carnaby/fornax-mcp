import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';
import { bearerHeader, callTool, useMcp } from './mcp-helpers.js';

const t = useTestApp();
const mcp = useMcp(() => t.app);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Alice's render job, claimed, with these files uploaded; `complete()` finishes it. */
async function jobWith(uploads: Array<[name: string, body: string | Buffer, kind?: 'output' | 'log']>) {
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
  const complete = () => t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: bearer(worker), payload: { lease } });
  return { alice, id, complete };
}

describe('get_output', () => {
  test('an image: its preview as an image block, and a link to the original that works without a token', async () => {
    const png = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: { r: 10, g: 120, b: 60 } } }).png().toBuffer();
    const job = await jobWith([['frame.png', png]]);
    await job.complete();
    const client = await mcp.connect('/mcp', bearerHeader(job.alice));
    const r = await callTool(client, 'get_output', { job_id: job.id, name: 'frame.png' });
    expect(r.isError).toBe(false);
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'image']);
    const info = JSON.parse(r.text);
    expect(info).toMatchObject({
      name: 'frame.png', mime: 'image/png', size: png.length, meta: null, preview: '.fornax/previews/frame.png.jpg', link_expires_at: '2026-11-14T10:00:00.000Z',
    });
    expect(r.blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(await sharp(Buffer.from(r.blocks[1]!.data!, 'base64')).metadata()).toMatchObject({ format: 'jpeg', width: 1024, height: 512 });
    const url = new URL(info.download_url);
    expect(url.origin).toBe('https://fornax.example.com');
    const original = await t.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.equals(png)).toBe(true);
  });

  test('text and JSON up to 100 kB come back as text; larger ones and other files as a link', async () => {
    const job = await jobWith([['result.json', '{"words": 3}'], ['big.txt', 'x'.repeat(100_001)], ['clip.mp4', 'MP4'], ['log.txt', 'all good', 'log']]);
    await job.complete();
    const client = await mcp.connect('/mcp', bearerHeader(job.alice));
    const get = (name: string) => callTool(client, 'get_output', { job_id: job.id, name });

    const json = await get('result.json');
    expect(json.blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(json.blocks[1]!.text).toBe('{"words": 3}');
    const log = await get('log.txt');
    expect(log.blocks[1]).toEqual({ type: 'text', text: 'all good' });

    const big = await get('big.txt');
    expect(big.blocks).toHaveLength(1);
    expect(JSON.parse(big.text)).toMatchObject({ name: 'big.txt', size: 100_001, download_url: expect.stringContaining('?sig='), note: expect.stringContaining('100 kB') });
    const video = await get('clip.mp4');
    expect(video.blocks).toHaveLength(1);
    expect(JSON.parse(video.text)).toMatchObject({ name: 'clip.mp4', mime: 'video/mp4', download_url: expect.stringContaining('/outputs/clip.mp4?sig=') });
  });

  test("before the job has finished, for an unknown name and for another client's job it is a tool error", async () => {
    const job = await jobWith([['a.txt', 'A']]);
    const client = await mcp.connect('/mcp', bearerHeader(job.alice));
    expect(await callTool(client, 'get_output', { job_id: job.id, name: 'a.txt' })).toMatchObject({
      isError: true, text: '409: the job is running; its outputs are ready once it has finished',
    });
    await job.complete();
    expect((await callTool(client, 'get_output', { job_id: job.id, name: 'a.txt' })).isError).toBe(false);
    expect(await callTool(client, 'get_output', { job_id: job.id, name: 'b.txt' })).toMatchObject({ isError: true, text: '404: output b.txt not found; get_job lists the outputs' });
    const other = await mcp.connect('/mcp', bearerHeader(issueToken(t.db, 'eve')));
    expect(await callTool(other, 'get_output', { job_id: job.id, name: 'a.txt' })).toMatchObject({ isError: true, text: `404: job ${job.id} not found` });
  });
});
