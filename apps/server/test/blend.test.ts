import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, test } from 'vitest';
import { blendFileVersion, blendVersion } from '../src/files/blend.js';

const dir = mkdtempSync(join(tmpdir(), 'fornax-blend-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fileWith = (name: string, data: Buffer) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};
/** A made-up .blend: the header, then bytes that stand for the file blocks. */
const blend = (header: string) => Buffer.concat([Buffer.from(header, 'latin1'), Buffer.alloc(4096, 7)]);

describe('blendVersion (spec 14 § 3.1)', () => {
  test('the 12-byte header of older Blender', () => {
    expect(blendVersion(blend('BLENDER-v503'))).toBe('5.3');
    expect(blendVersion(blend('BLENDER_v402'))).toBe('4.2');
    expect(blendVersion(blend('BLENDER-V293'))).toBe('2.93');
  });

  test('the 17-byte header of newer Blender', () => {
    expect(blendVersion(blend('BLENDER17-01v0503'))).toBe('5.3');
    expect(blendVersion(blend('BLENDER17-01v0500'))).toBe('5.0');
  });

  test('anything else has no version', () => {
    expect(blendVersion(Buffer.from('PK'))).toBeNull();
    expect(blendVersion(Buffer.from('BLENDER'))).toBeNull();
    expect(blendVersion(blend('BLENDERxxxxx'))).toBeNull();
  });
});

describe('blendFileVersion', () => {
  test('a plain and a zstd-compressed file', async () => {
    expect(await blendFileVersion(fileWith('plain.blend', blend('BLENDER17-01v0502')))).toBe('5.2');
    expect(await blendFileVersion(fileWith('packed.blend', zstdCompressSync(blend('BLENDER-v503'))))).toBe('5.3');
  });

  test('a broken zstd stream gives no version and the upload still succeeds', async () => {
    const broken = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(64, 0xff)]);
    expect(await blendFileVersion(fileWith('broken.blend', broken))).toBeNull();
    expect(await blendFileVersion(join(dir, 'missing.blend'))).toBeNull();
  });
});
