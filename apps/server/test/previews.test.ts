import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { files } from '../src/db/schema.js';
import { outputBudget } from '../src/domain/outputs.js';
import { PREVIEW_MAX_PX, renderPreview, serverPreviewName } from '../src/files/preview.js';
import { FileStore } from '../src/files/store.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';

const t = useTestApp();
const deps = () => ({ config: t.config, db: t.db, store: new FileStore(t.config.filesDir), clock: () => t.clock.now });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const image = (width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'tiff' | 'gif' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).toFormat(format).toBuffer();
const previewRow = (output: string) => t.db.select().from(files).all().find((f) => f.name === serverPreviewName(output));

/** Alice's render job, claimed by the worker; helpers to upload outputs, complete it and read it back. */
async function running() {
  announce(t.db, [renderContract], t.clock.now);
  const worker = issueToken(t.db, 'pc', 'worker');
  const alice = issueToken(t.db, 'alice');
  const scene = await uploadFile(t.app, alice, 'scene.blend', 'B');
  const id = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer(alice), payload: { type: 'render', params: { frame_start: 1 }, inputs: { scene } } })).json().id as string;
  const lease = (await t.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: bearer(worker), payload: { wait: 0 } })).json().lease as string;
  return {
    id,
    lease,
    put: (name: string, body: string | Buffer, kind = 'output') =>
      t.app.inject({
        method: 'PUT', url: `/api/worker/jobs/${id}/outputs/${name}?kind=${kind}`,
        headers: { ...bearer(worker), 'content-type': 'application/octet-stream', 'x-fornax-lease': lease }, payload: body,
      }),
    complete: (outputs: object) => t.app.inject({ method: 'POST', url: `/api/worker/jobs/${id}/complete`, headers: bearer(worker), payload: { lease, outputs } }),
    get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(alice) }),
  };
}

describe('renderPreview', () => {
  test('fits the longer side into 1024 px as a JPEG and never enlarges', async () => {
    for (const [w, h, want] of [[2048, 1024, [1024, 512]], [512, 2048, [256, 1024]], [300, 200, [300, 200]]] as const) {
      const src = join(t.dir, `${w}x${h}.png`);
      writeFileSync(src, await image(w, h));
      expect(await sharp(await renderPreview(src)).metadata()).toMatchObject({ format: 'jpeg', width: want[0], height: want[1] });
    }
    expect(PREVIEW_MAX_PX).toBe(1024);
  });

  test('reads jpeg, webp, tiff and gif', async () => {
    for (const format of ['jpeg', 'webp', 'tiff', 'gif'] as const) {
      const src = join(t.dir, `a.${format}`);
      writeFileSync(src, await image(64, 32, format));
      expect((await sharp(await renderPreview(src)).metadata()).format, format).toBe('jpeg');
    }
  });

  test('refuses what is not an image', async () => {
    const src = join(t.dir, 'bad.png');
    writeFileSync(src, 'not a png');
    await expect(renderPreview(src)).rejects.toThrow();
  });
});

describe('server previews', () => {
  test('an image output gets a JPEG preview that the manifest names', async () => {
    const r = await running();
    expect((await r.put('frame.png', await image(2048, 1024))).statusCode).toBe(201);
    expect(previewRow('frame.png')).toMatchObject({ kind: 'preview', mime: 'image/jpeg', jobId: r.id });
    expect((await r.complete({})).statusCode).toBe(200);
    const job = (await r.get(`/api/jobs/${r.id}`)).json();
    expect(job.outputs).toEqual([expect.objectContaining({ name: 'frame.png', preview: '.fornax/previews/frame.png.jpg' })]);
    const jpeg = await r.get(`/api/jobs/${r.id}/outputs/.fornax/previews/frame.png.jpg`);
    expect(jpeg.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(jpeg.rawPayload).metadata()).width).toBe(1024);
  });

  test("the tool's own preview wins", async () => {
    const r = await running();
    await r.put('frame.png', await image(64, 64));
    await r.put('previews/frame.jpg', await image(16, 16, 'jpeg'));
    await r.complete({ 'frame.png': { preview: 'previews/frame.jpg' } });
    const job = (await r.get(`/api/jobs/${r.id}`)).json();
    expect(job.outputs).toEqual([expect.objectContaining({ name: 'frame.png', preview: 'previews/frame.jpg' })]);
  });

  test('an image that cannot be decoded gets no preview; the upload still succeeds', async () => {
    const r = await running();
    expect((await r.put('broken.png', 'not a png')).statusCode).toBe(201);
    expect(previewRow('broken.png')).toBeUndefined();
    await r.complete({});
    expect((await r.get(`/api/jobs/${r.id}`)).json().outputs).toEqual([expect.objectContaining({ name: 'broken.png', preview: null })]);
  });

  test('other formats get none', async () => {
    const r = await running();
    await r.put('render.exr', 'EXR');
    await r.put('notes.txt', 'hello');
    expect(t.db.select().from(files).all().filter((f) => f.kind === 'preview')).toEqual([]);
  });

  test('a new upload under the same name replaces the preview, or drops it when the new file is no image', async () => {
    const r = await running();
    await r.put('frame.png', await image(2048, 1024));
    const first = previewRow('frame.png')!;
    await r.put('frame.png', await image(400, 200));
    const second = previewRow('frame.png')!;
    expect(second.id).not.toBe(first.id);
    expect(existsSync(join(t.config.filesDir, first.id))).toBe(false);
    await r.put('frame.png', 'not an image any more');
    expect(previewRow('frame.png')).toBeUndefined();
    expect(existsSync(join(t.config.filesDir, second.id))).toBe(false);
  });

  test('server previews do not count against the output limit', async () => {
    const r = await running();
    const png = await image(2048, 1024);
    await r.put('frame.png', png);
    expect(previewRow('frame.png')).toBeDefined();
    expect(outputBudget(deps(), r.id, r.lease, 'other.bin')).toBe(t.config.limits.maxOutputBytes - png.length);
  });
});

describe('complete refuses a preview that is not a separate file', () => {
  test('the log, the output itself, or another listed output', async () => {
    const r = await running();
    await r.put('a.png', await image(10, 10));
    await r.put('b.png', await image(10, 10));
    await r.put('log.txt', 'x', 'log');
    for (const outputs of [{ 'a.png': { preview: 'log.txt' } }, { 'a.png': { preview: 'a.png' } }, { 'a.png': { preview: 'b.png' }, 'b.png': { meta: { w: 1 } } }]) {
      expect((await r.complete(outputs)).statusCode, JSON.stringify(outputs)).toBe(400);
    }
    expect((await r.complete({ 'a.png': { preview: 'b.png' } })).statusCode).toBe(200);
  });
});
