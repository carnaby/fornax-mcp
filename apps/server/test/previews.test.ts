import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { files } from '../src/db/schema.js';
import { outputBudget } from '../src/domain/outputs.js';
import { PREVIEW_MAX_PX, renderPreview, serverPreviewName } from '../src/files/preview.js';
import { FileStore } from '../src/files/store.js';
import { buildApp } from '../src/http/app.js';
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
    headers: { ...bearer(worker), 'x-fornax-lease': lease },
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

  test('decodes only png, jpeg, webp, tiff and gif, whatever the extension says', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>';
    expect((await sharp(Buffer.from(svg)).metadata()).format).toBe('svg'); // sharp itself would render it
    const src = join(t.dir, 'drawing.png');
    writeFileSync(src, svg);
    await expect(renderPreview(src)).rejects.toThrow();
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

  test('an SVG named .png gets none', async () => {
    const r = await running();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>';
    expect((await r.put('drawing.png', svg)).statusCode).toBe(201);
    expect(previewRow('drawing.png')).toBeUndefined();
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

describe('a disk error while storing a preview', () => {
  /** A store that fails on demand: every write after the next `writesLeft` ones, or removing the ids in `failRemove`. */
  class FlakyStore extends FileStore {
    failRemove = new Set<string>();
    writesLeft = Number.POSITIVE_INFINITY;
    override async write(id: string, source: Readable, maxBytes: number) {
      if (this.writesLeft-- <= 0) throw new Error('disk full');
      return super.write(id, source, maxBytes);
    }
    override async remove(id: string): Promise<void> {
      if (this.failRemove.has(id)) throw new Error('disk error');
      return super.remove(id);
    }
  }

  async function flaky() {
    const r = await running();
    const store = new FlakyStore(t.config.filesDir);
    const lines: string[] = [];
    const app = await buildApp({ config: t.config, db: t.db, store, clock: () => t.clock.now, logStream: { write: (m) => void lines.push(m) } });
    const put = (name: string, body: Buffer) =>
      app.inject({ method: 'PUT', url: `/api/worker/jobs/${r.id}/outputs/${name}`, headers: { ...r.headers, 'content-type': 'application/octet-stream' }, payload: body });
    return { r, store, lines, app, put };
  }

  test('a failing write of the preview is logged with the file id only; the upload succeeds', async () => {
    const f = await flaky();
    try {
      f.store.writesLeft = 1; // the output itself is stored; its preview is not
      const res = await f.put('frame.png', await image(2048, 1024));
      expect(res.statusCode).toBe(201);
      expect(previewRow('frame.png')).toBeUndefined();
      const output = t.db.select().from(files).all().find((x) => x.name === 'frame.png')!;
      expect(f.lines.join('')).toContain(output.id);
      expect(f.lines.join('')).not.toContain('disk full');
    } finally {
      await f.app.close();
    }
  });

  test('a failing removal of the previous preview is logged and ignored', async () => {
    const f = await flaky();
    try {
      expect((await f.put('frame.png', await image(400, 200))).statusCode).toBe(201);
      const first = previewRow('frame.png')!.id;
      f.store.failRemove.add(first);
      expect((await f.put('frame.png', await image(800, 400))).statusCode).toBe(201);
      // The stale preview is never shown again: one preview row, of the new upload.
      const rows = t.db.select().from(files).all().filter((x) => x.name === serverPreviewName('frame.png'));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).not.toBe(first);
      expect(f.lines.join('')).toContain(first);
      expect(f.lines.join('')).not.toContain('disk error');
    } finally {
      await f.app.close();
    }
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
