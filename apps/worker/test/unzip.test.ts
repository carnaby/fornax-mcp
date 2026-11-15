import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { zipBuffer } from '../scripts/zip.mjs';
import { extractWorkerZip, readZip, ZipError } from '../src/install/unzip.js';
import { workerZip } from './bundle-fixture.js';
import { useTempDir } from './helpers.js';

const tmp = useTempDir();

describe('readZip', () => {
  test('reads stored and deflated entries with their modes', () => {
    const big = Buffer.from('x'.repeat(10_000)); // deflates
    const tiny = Buffer.from('a'); // stays stored
    const entries = readZip(zipBuffer([
      { name: 'fornax-worker/big.txt', data: big },
      { name: 'fornax-worker/tiny.txt', data: tiny },
      { name: 'fornax-worker/fornax', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      { name: 'fornax-worker/empty', data: Buffer.alloc(0) },
    ]));
    expect(entries.map((e) => [e.name, e.data.length, e.mode])).toEqual([
      ['fornax-worker/big.txt', 10_000, 0o644],
      ['fornax-worker/tiny.txt', 1, 0o644],
      ['fornax-worker/fornax', 10, 0o755],
      ['fornax-worker/empty', 0, 0o644],
    ]);
    expect(entries[0]!.data.equals(big)).toBe(true);
  });

  test('a damaged entry, a foreign method, a cut zip or no zip at all is a ZipError', () => {
    const good = zipBuffer([{ name: 'fornax-worker/a.txt', data: Buffer.from('hello hello hello hello hello') }]);
    // Flip one byte of the entry's data (it starts after the 30-byte local header and the name).
    const damaged = Buffer.from(good);
    const dataAt = 30 + 'fornax-worker/a.txt'.length;
    damaged[dataAt] = damaged[dataAt]! ^ 0xff;
    expect(() => readZip(damaged)).toThrow(ZipError);
    // Method 12 (bzip2) in the central directory.
    const cen = good.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const method = Buffer.from(good);
    method.writeUInt16LE(12, cen + 10);
    expect(() => readZip(method)).toThrow(/compression method 12/);
    expect(() => readZip(good.subarray(0, good.length - 30))).toThrow(ZipError);
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(ZipError);
  });
});

describe('extractWorkerZip', () => {
  test('writes the files under fornax-worker/ into the destination; the launcher stays executable on Linux', () => {
    const dest = join(tmp(), 'app.new');
    extractWorkerZip(workerZip({ version: '1.2.3', packs: { echo: { 'type.yaml': 'name: echo\n' } } }), dest);
    expect(readFileSync(join(dest, 'VERSION'), 'utf8')).toBe('1.2.3\n');
    expect(readFileSync(join(dest, 'types', 'echo', 'type.yaml'), 'utf8')).toBe('name: echo\n');
    if (process.platform !== 'win32') expect(statSync(join(dest, 'fornax')).mode & 0o111).not.toBe(0);
  });

  test.each([
    ['outside the root folder', 'other/x.txt'],
    ['with ..', 'fornax-worker/../x.txt'],
    ['with a backslash', 'fornax-worker/types\\x.txt'],
    ['with a drive letter', 'fornax-worker/C:/x.txt'],
    ['the root itself', 'fornax-worker/'],
  ])('an entry %s is refused and nothing is written', (_why, name) => {
    const dest = join(tmp(), 'app.new');
    expect(() => extractWorkerZip(workerZip({}, [{ name, data: Buffer.from('x') }]), dest)).toThrow(ZipError);
    expect(existsSync(dest)).toBe(false);
  });
});
