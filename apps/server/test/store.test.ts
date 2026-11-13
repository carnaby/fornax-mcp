import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { FileStore } from '../src/files/store.js';

let dir: string;
let store: FileStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fornax-store-'));
  store = new FileStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('write stores the bytes and returns size and sha256', async () => {
  const data = Buffer.from('hello fornax');
  const r = await store.write('01ID', Readable.from([data]), 100);
  expect(r).toEqual({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  expect(readFileSync(store.pathOf('01ID'))).toEqual(data);
});

test('over the limit: 413 and nothing left behind', async () => {
  const chunks = [Buffer.alloc(60), Buffer.alloc(60)];
  await expect(store.write('01BIG', Readable.from(chunks), 100)).rejects.toMatchObject({ status: 413 });
  expect(existsSync(store.pathOf('01BIG'))).toBe(false);
  expect(readdirSync(store.tmp)).toEqual([]);
});

test('remove is idempotent', async () => {
  await store.write('01X', Readable.from([Buffer.from('x')]), 10);
  await store.remove('01X');
  await store.remove('01X');
  expect(existsSync(store.pathOf('01X'))).toBe(false);
});

test('a source that errors mid-stream rejects the write and leaves nothing behind', async () => {
  const source = new Readable({ read() {} });
  const p = store.write('01ERR', source, 100);
  source.push(Buffer.from('partial'));
  await new Promise((r) => setTimeout(r, 20));
  source.destroy(new Error('socket reset'));
  await expect(p).rejects.toThrow('socket reset');
  expect(existsSync(store.pathOf('01ERR'))).toBe(false);
  expect(readdirSync(store.tmp)).toEqual([]);
});

test('a source closed early counts as an aborted upload', async () => {
  const source = new Readable({ read() {} });
  const p = store.write('01CUT', source, 100);
  source.push(Buffer.from('partial'));
  await new Promise((r) => setTimeout(r, 20));
  source.destroy();
  await expect(p).rejects.toThrow('upload aborted');
  expect(readdirSync(store.tmp)).toEqual([]);
});
