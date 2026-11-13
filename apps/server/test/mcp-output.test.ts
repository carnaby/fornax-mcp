import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { files } from '../src/db/schema.js';
import { serverPreviewName } from '../src/files/preview.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';
import { bearerHeader, callTool, useMcp } from './mcp-helpers.js';

const t = useTestApp({ limits: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxQueuedPerToken: 50 } });
const mcp = useMcp(() => t.app);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 60 } } }).png().toBuffer();

/** A PNG whose header claims `width` x `height` pixels, without the pixels: tiny on disk, huge once decoded. */
function pngHeaderOnly(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(0))), chunk('IEND', Buffer.alloc(0))]);
}

/** As if the server could not make a preview of `output` (e.g. it timed out): its row and file go before complete. */
const dropServerPreview = (jobId: string, output: string) =>
  t.db.delete(files).where(and(eq(files.jobId, jobId), eq(files.name, serverPreviewName(output)))).run();

const pixels = async (b: { data?: string }) => {
  const m = await sharp(Buffer.from(b.data!, 'base64')).metadata();
  return { format: m.format, width: m.width, height: m.height };
};

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
  const complete = (outputs: object = {}) => t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: bearer(worker), payload: { lease, outputs } });
  return { alice, id, complete, get: async (name: string) => callTool(await mcp.connect('/mcp', bearerHeader(alice)), 'get_output', { job_id: id, name }) };
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

  test('text and JSON up to 60 kB come back as text; larger ones and other files as a link', async () => {
    const job = await jobWith([['result.json', '{"words": 3}'], ['big.txt', 'x'.repeat(60_001)], ['clip.mp4', 'MP4'], ['log.txt', 'all good', 'log']]);
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
    expect(JSON.parse(big.text)).toMatchObject({ name: 'big.txt', size: 60_001, download_url: expect.stringContaining('?sig='), note: expect.stringContaining('60 kB') });
    const video = await get('clip.mp4');
    expect(video.blocks).toHaveLength(1);
    expect(JSON.parse(video.text)).toMatchObject({ name: 'clip.mp4', mime: 'video/mp4', download_url: expect.stringContaining('/outputs/clip.mp4?sig=') });
  });

  test('a log over 60 kB comes back as its last 60 kB, cut on a character boundary', async () => {
    // 'é' is two bytes in UTF-8; the cut at 60 000 bytes from the end falls inside one of them.
    const log = `${'é'.repeat(40_000)}x${'y'.repeat(9_998)}END`;
    const job = await jobWith([['log.txt', log, 'log']]);
    await job.complete();
    const r = await job.get('log.txt');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(JSON.parse(r.text)).toMatchObject({ name: 'log.txt', size: Buffer.byteLength(log), note: expect.stringContaining('last 60 kB') });
    const tail = r.blocks[1]!.text!;
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(60_000);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(59_990);
    expect(log.endsWith(tail)).toBe(true);
    expect(tail.startsWith('é')).toBe(true);
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

  test('the image block carries the type its bytes have; bytes that are no browser image, or text with NUL, become a link', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    t.quietLogs(); // fake.png gets no server preview, on purpose
    const job = await jobWith([['photo.png', jpeg], ['fake.png', 'not an image'], ['bin.txt', Buffer.from('a\0b')]]);
    await job.complete();
    const client = await mcp.connect('/mcp', bearerHeader(job.alice));
    const get = (name: string) => callTool(client, 'get_output', { job_id: job.id, name });

    const photo = await get('photo.png');
    expect(photo.blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(photo.blocks[1]).toMatchObject({ mimeType: 'image/jpeg' });
    for (const name of ['fake.png', 'bin.txt']) {
      const r = await get(name);
      expect(r.blocks, name).toHaveLength(1);
      expect(JSON.parse(r.text), name).toMatchObject({ name, note: expect.stringContaining('link') });
    }
  });

  test("a large tool preview comes back as the server's rendering of it, at most 2000 px per side", async () => {
    const job = await jobWith([['frame.exr', 'EXR'], ['previews/frame.png', await solid(3000, 1500)]]);
    expect((await job.complete({ 'frame.exr': { preview: 'previews/frame.png' } })).statusCode).toBe(200);
    const r = await job.get('frame.exr');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(JSON.parse(r.text)).toMatchObject({ name: 'frame.exr', preview: 'previews/frame.png' });
    expect(await pixels(r.blocks[1]!)).toEqual({ format: 'jpeg', width: 1024, height: 512 });
  });

  test('a small image without a preview is inlined as it is', async () => {
    const png = await solid(64, 48);
    const job = await jobWith([['small.png', png]]);
    dropServerPreview(job.id, 'small.png');
    await job.complete();
    const r = await job.get('small.png');
    expect(r.blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(r.blocks[1]!.data!, 'base64').equals(png)).toBe(true);
  });

  test('an image over 2 MiB without a preview comes back rendered, at most 1024 px', async () => {
    const noise = await sharp(randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).png().toBuffer();
    expect(noise.length).toBeGreaterThan(2 * 1024 * 1024);
    const job = await jobWith([['noise.png', noise]]);
    dropServerPreview(job.id, 'noise.png');
    await job.complete();
    const r = await job.get('noise.png');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(await pixels(r.blocks[1]!)).toEqual({ format: 'jpeg', width: 1000, height: 1000 });
  });

  test('a PNG of over 100 megapixels is never inlined, however few bytes it has', async () => {
    const huge = pngHeaderOnly(12_000, 12_000);
    expect(huge.length).toBeLessThan(100);
    t.quietLogs(); // the server refuses to make a preview of it, on purpose
    const job = await jobWith([['huge.png', huge]]);
    await job.complete();
    const r = await job.get('huge.png');
    expect(r.blocks).toHaveLength(1);
    expect(JSON.parse(r.text)).toMatchObject({ name: 'huge.png', note: expect.stringContaining('link') });
    expect(t.logs.join('')).toContain('no preview: the image could not be decoded');
  });

  test('an image of more than 2000 px per side is never inlined raw', async () => {
    const wide = await solid(2400, 100);
    const job = await jobWith([['wide.png', wide]]);
    dropServerPreview(job.id, 'wide.png');
    await job.complete();
    const r = await job.get('wide.png');
    expect(await pixels(r.blocks[1]!)).toEqual({ format: 'jpeg', width: 1024, height: 43 });
  });
});
