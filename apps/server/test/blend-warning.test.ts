import { eq } from 'drizzle-orm';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { files } from '../src/db/schema.js';
import { renderContract } from './fixtures.js';
import { announce, issueToken, uploadFile, useTestApp } from './helpers.js';
import { bearerHeader, callJson, useMcp } from './mcp-helpers.js';

const t = useTestApp();
const mcp = useMcp(() => t.app);
const RENDER_ENV = 'Blender 5.2.2 LTS, Cycles on OPTIX (Example GPU); ffmpeg 9.0';
const blend = (header: string) => Buffer.concat([Buffer.from(header, 'latin1'), Buffer.alloc(1024, 7)]);
const NEWER = 'scene was saved by Blender 5.3; the worker runs Blender 5.2.2 LTS, which may lose data: save it with Blender 5.2 or older.';

async function upload(body: Buffer) {
  announce(t.db, [renderContract], t.clock.now, { render: RENDER_ENV });
  const alice = issueToken(t.db, 'alice');
  return { alice, scene: await uploadFile(t.app, alice, 'scene.blend', body) };
}

describe('the .blend version (spec 14 § 3)', () => {
  test('the upload keeps the version in meta, also of a zstd file', async () => {
    const { scene } = await upload(zstdCompressSync(blend('BLENDER17-01v0503')));
    expect(t.db.select().from(files).where(eq(files.id, scene)).get()?.meta).toEqual({ blender: '5.3' });
  });

  test('a broken zstd .blend uploads fine, without a version', async () => {
    const { scene } = await upload(Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(64, 0xff)]));
    expect(t.db.select().from(files).where(eq(files.id, scene)).get()?.meta).toBeNull();
  });

  test('a newer .blend: the job is queued with a warning, over MCP and REST', async () => {
    const { alice, scene } = await upload(blend('BLENDER-v503'));
    const client = await mcp.connect('/mcp', bearerHeader(alice));
    const r = await callJson(client, 'submit_job', { type: 'render', params: { frame_start: 1 }, inputs: { scene } });
    expect(r).toMatchObject({ state: 'queued', warning: NEWER });
    const rest = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: { authorization: `Bearer ${alice}` }, payload: { type: 'render', params: { frame_start: 2 }, inputs: { scene } } });
    expect(rest.json()).toMatchObject({ state: 'queued', warning: NEWER });
  });

  test('the same or an older version, or no header, gives no warning', async () => {
    for (const header of ['BLENDER-v502', 'BLENDER_v410', 'NOTABLEND!!!']) {
      const { alice, scene } = await upload(blend(header));
      const client = await mcp.connect('/mcp', bearerHeader(alice));
      expect(await callJson(client, 'submit_job', { type: 'render', params: { frame_start: 1 }, inputs: { scene } }), header).not.toHaveProperty('warning');
    }
  });

  test('a type without a Blender environment compares nothing', async () => {
    announce(t.db, [renderContract], t.clock.now);
    const alice = issueToken(t.db, 'alice');
    const scene = await uploadFile(t.app, alice, 'scene.blend', blend('BLENDER-v599'));
    const client = await mcp.connect('/mcp', bearerHeader(alice));
    expect(await callJson(client, 'submit_job', { type: 'render', params: { frame_start: 1 }, inputs: { scene } })).not.toHaveProperty('warning');
  });

  test('idle and a newer .blend: both warnings, idle first', async () => {
    const { alice, scene } = await upload(blend('BLENDER-v503'));
    const client = await mcp.connect('/mcp', bearerHeader(alice));
    const r = await callJson(client, 'submit_job', { type: 'render', params: { frame_start: 1 }, inputs: { scene }, priority: 'idle' });
    expect(r.warning).toBe(`this job waits until the operator starts it; pass priority normal to run it automatically; ${NEWER}`);
  });
});
