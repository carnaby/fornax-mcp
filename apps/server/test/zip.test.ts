import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, test } from 'vitest';
import { needsZip64, type ZipEntry, zipSize, zipStream } from '../src/files/zip.js';

const dir = mkdtempSync(join(tmpdir(), 'fornax-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An entry whose stream comes in two chunks, as a file read does. */
const entry = (name: string, data: Buffer): ZipEntry => ({ name, size: data.length, open: () => Readable.from([data.subarray(0, 3), data.subarray(3)]) });
const collect = async (r: Readable) => {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(c as Buffer);
  return Buffer.concat(parts);
};

/** A ZIP reader that is not ours: unzip (Linux CI) or the bsdtar of Windows; null when neither is there. */
function externalReader(): { list: (zip: string) => string[]; read: (zip: string, name: string) => Buffer } | null {
  if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0) {
    return {
      list: (zip) => {
        execFileSync('unzip', ['-tq', zip]); // throws on a bad CRC or a broken structure
        return execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
      },
      read: (zip, name) => execFileSync('unzip', ['-p', zip, name]),
    };
  }
  const root = process.env.SystemRoot;
  const tar = process.platform === 'win32' && root ? join(root, 'System32', 'tar.exe') : null;
  if (tar && existsSync(tar)) {
    return {
      list: (zip) => execFileSync(tar, ['-tf', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean),
      read: (zip, name) => execFileSync(tar, ['-xOf', zip, name]),
    };
  }
  return null;
}
const reader = externalReader();
if (!reader) console.warn('zip.test: neither unzip nor the Windows tar.exe is here: the ZIP is not checked by another reader');

const files = () => [
  entry('frame_0001.png', Buffer.from('made-up frame one')),
  entry('sub/notes.txt', Buffer.from('Poznámky: ľščť', 'utf8')),
  entry('log.txt', Buffer.alloc(70_000, 'y')),
];
const modified = new Date(Date.UTC(2026, 10, 25, 18, 30, 4));

describe('zipStream (spec 14 § 4.2)', () => {
  for (const zip64 of [false, true]) {
    test(`${zip64 ? 'ZIP64' : 'classic'}: the size is known ahead and another reader gets every file back`, async () => {
      const bytes = await collect(zipStream(files(), modified, { zip64 }));
      expect(bytes.length).toBe(zipSize(files(), { zip64 }));
      // The end of central directory record, and before it the ZIP64 record and locator when asked for.
      expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
      if (zip64) {
        expect(bytes.readUInt32LE(bytes.length - 22 - 20)).toBe(0x07064b50);
        expect(bytes.readUInt32LE(bytes.length - 22 - 20 - 56)).toBe(0x06064b50);
      } else {
        expect(bytes.readUInt16LE(bytes.length - 22 + 10)).toBe(3);
      }
      if (!reader) return;
      const path = join(dir, `t-${zip64}.zip`);
      writeFileSync(path, bytes);
      expect(reader.list(path)).toEqual(['frame_0001.png', 'sub/notes.txt', 'log.txt']);
      expect(reader.read(path, 'sub/notes.txt').toString('utf8')).toBe('Poznámky: ľščť');
      expect(reader.read(path, 'log.txt').equals(Buffer.alloc(70_000, 'y'))).toBe(true);
    });
  }

  test('an entry that ends early fails the stream', async () => {
    const short: ZipEntry = { name: 'a.bin', size: 10, open: () => Readable.from([Buffer.from('abc')]) };
    await expect(collect(zipStream([short], modified))).rejects.toThrow('a.bin has 3 bytes, not 10');
  });
});

describe('needsZip64', () => {
  const sized = (size: number): ZipEntry => ({ name: 'x', size, open: () => Readable.from([]) });
  test('only for a file or an offset of 4 GiB or more, or 65 535 entries', () => {
    expect(needsZip64(files())).toBe(false);
    expect(needsZip64([sized(0xffffffff)])).toBe(true);
    expect(needsZip64([sized(0x80000000), sized(0x80000000)])).toBe(true);
    expect(needsZip64(Array.from({ length: 65_535 }, () => sized(0)))).toBe(true);
  });
});
