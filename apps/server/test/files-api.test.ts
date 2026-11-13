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

describe('aborted and oversized uploads', () => {
  test('after an aborted upload through a link, the link is usable again', async () => {
    const { Readable } = await import('node:stream');
    const { createUploadLink, takeUploadLink, releaseUploadLink, saveFile } = await import('../src/domain/files.js');
    const majo = issueToken(t.db, 'majo');
    const owner = (await t.app.inject({ method: 'GET', url: '/api/whoami', headers: { authorization: `Bearer ${majo}` } })).json().name;
    expect(owner).toBe('majo');
    const { tokens } = await import('../src/db/schema.js');
    const tokenId = t.db.select().from(tokens).all()[0]!.id;
    const deps = { config: t.config, db: t.db, store: new (await import('../src/files/store.js')).FileStore(t.config.filesDir), clock: () => t.clock.now };
    const link = createUploadLink(deps, tokenId, 'a.bin');
    const id = new URL(link.url).pathname.split('/').pop()!.split('.')[0]!;
    const row = takeUploadLink(t.db, id, t.clock.now)!;
    const source = new Readable({ read() {} });
    const p = saveFile(deps, { owner: tokenId, id: row.fileId, name: row.name, kind: 'input', source, maxBytes: 100 });
    source.push(Buffer.from('x'));
    source.destroy();
    await expect(p).rejects.toThrow('upload aborted');
    releaseUploadLink(t.db, row.id);
    expect(takeUploadLink(t.db, id, t.clock.now)).not.toBeNull();
  });

  test('real socket: an oversized body gets 413 and the connection closes', async () => {
    const { request } = await import('node:http');
    const majo = issueToken(t.db, 'majo');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as { port: number }).port;
    // The server closes the connection without reading the rest of the body. Depending on the OS the
    // client then sees the 413 reply or a connection reset (unread data makes the close an RST); either
    // way the call finishes instead of hanging.
    const outcome = await new Promise<number | 'reset'>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/files?name=big.bin', headers: { authorization: `Bearer ${majo}`, 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (e) => {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ECONNRESET' || code === 'EPIPE') resolve('reset');
        else reject(e);
      });
      const chunk = Buffer.alloc(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 4 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    expect([413, 'reset']).toContain(outcome);
    expect(t.db.select().from(files).all()).toEqual([]);
    expect(readdirSync(join(t.config.filesDir, 'tmp'))).toEqual([]);
  });
});
