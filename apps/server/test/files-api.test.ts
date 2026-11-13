import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { files } from '../src/db/schema.js';
import { issueToken, useTestApp } from './helpers.js';

const t = useTestApp();
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('direct upload', () => {
  test('POST /api/files stores the body', async () => {
    const majo = issueToken(t.db, 'majo');
    const body = Buffer.from('RIFF....WAVE');
    const res = await t.app.inject({ method: 'POST', url: '/api/files?name=talk.wav', headers: auth(majo), payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'talk.wav', size: body.length, sha256: sha(body), mime: 'audio/wav' });
  });

  test('over the limit: 413, no row, no file', async () => {
    const majo = issueToken(t.db, 'majo');
    const res = await t.app.inject({ method: 'POST', url: '/api/files?name=big.bin', headers: auth(majo), payload: Buffer.alloc(1024 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
    expect(t.db.select().from(files).all()).toEqual([]);
    expect(readdirSync(join(t.config.filesDir)).filter((f) => f !== 'tmp')).toEqual([]);
    expect(readdirSync(join(t.config.filesDir, 'tmp'))).toEqual([]);
  });

  test('another client cannot see the file', async () => {
    const majo = issueToken(t.db, 'majo');
    const eve = issueToken(t.db, 'eve');
    const id = (await t.app.inject({ method: 'POST', url: '/api/files?name=a.txt', headers: auth(majo), payload: 'a' })).json().id;
    expect((await t.app.inject({ method: 'GET', url: `/api/files/${id}`, headers: auth(majo) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/files/${id}`, headers: auth(eve) })).statusCode).toBe(404);
  });
});

describe('upload links', () => {
  test('the link takes one upload without a token, into the announced file id', async () => {
    const majo = issueToken(t.db, 'majo');
    const link = (await t.app.inject({ method: 'POST', url: '/api/uploads', headers: { authorization: `Bearer ${majo}` }, payload: { name: 'scene.blend' } })).json();
    expect(link.url).toMatch(/^https:\/\/fornax\.example\.com\/api\/uploads\//);
    expect(link.curl).toContain(link.url);
    const path = new URL(link.url).pathname;
    const put = await t.app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'application/octet-stream' }, payload: 'BLENDER' });
    expect(put.statusCode).toBe(201);
    expect(put.json()).toMatchObject({ id: link.file_id, name: 'scene.blend', size: 7 });
    const again = await t.app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'application/octet-stream' }, payload: 'X' });
    expect(again.statusCode).toBe(404);
  });

  test('expired or tampered links are 404', async () => {
    const majo = issueToken(t.db, 'majo');
    const link = (await t.app.inject({ method: 'POST', url: '/api/uploads', headers: { authorization: `Bearer ${majo}` }, payload: { name: 'a.bin' } })).json();
    const path = new URL(link.url).pathname;
    expect((await t.app.inject({ method: 'PUT', url: `${path}x`, payload: 'a', headers: { 'content-type': 'application/octet-stream' } })).statusCode).toBe(404);
    t.clock.advance(3_600_001);
    expect((await t.app.inject({ method: 'PUT', url: path, payload: 'a', headers: { 'content-type': 'application/octet-stream' } })).statusCode).toBe(404);
  });

  test('a failed upload leaves the link usable', async () => {
    const majo = issueToken(t.db, 'majo');
    const link = (await t.app.inject({ method: 'POST', url: '/api/uploads', headers: { authorization: `Bearer ${majo}` }, payload: { name: 'a.bin' } })).json();
    const path = new URL(link.url).pathname;
    const headers = { 'content-type': 'application/octet-stream' };
    expect((await t.app.inject({ method: 'PUT', url: path, headers, payload: Buffer.alloc(1024 * 1024 + 1) })).statusCode).toBe(413);
    expect((await t.app.inject({ method: 'PUT', url: path, headers, payload: 'ok' })).statusCode).toBe(201);
  });
});
