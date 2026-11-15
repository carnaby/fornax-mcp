import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { InstallError } from './errors.js';

/** The download is not a worker zip as apps/worker/scripts/zip.mjs writes it. */
export class ZipError extends InstallError {}

export type ZipEntry = { name: string; data: Buffer; mode: number };

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Every entry of a worker zip lies in this folder. */
export const ZIP_ROOT = 'fornax-worker/';

const bad = (why: string) => new ZipError(`the download is not a fornax worker zip (${why})`);

/**
 * The entries of a zip as the bundle writes it (spec 05c 4.2): stored or deflated, no zip64, no encryption. Every
 * entry's size and CRC-32 are checked; anything else is a ZipError.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw bad('too short');
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw bad('no end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  if (count === 0xffff || p === 0xffffffff) throw bad('zip64');
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw bad('broken central directory');
    if (buf.readUInt16LE(p + 8) & 1) throw bad('encrypted');
    const method = buf.readUInt16LE(p + 10);
    if (method !== 0 && method !== 8) throw bad(`compression method ${method}`);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const attributes = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLength > buf.length) throw bad('broken central directory');
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw bad(`broken local header of ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > buf.length) throw bad(`${name} is cut off`);
    const body = buf.subarray(start, start + packed);
    let data: Buffer;
    try {
      data = method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : Buffer.from(body);
    } catch {
      throw bad(`${name} cannot be unpacked`);
    }
    if (data.length !== size || crc32(data) !== crc) throw bad(`${name} is damaged`);
    entries.push({ name, data, mode: (attributes >>> 16) & 0o777 });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The path of an entry inside ZIP_ROOT, split; throws for anything that could leave the destination. */
function partsOf(name: string): string[] {
  const rel = name.startsWith(ZIP_ROOT) ? name.slice(ZIP_ROOT.length) : null;
  const parts = rel?.split('/') ?? [];
  const unsafe =
    rel === null || rel === '' || name.includes('\\') || /^[a-zA-Z]:/.test(rel) || parts.some((s) => s === '' || s === '.' || s === '..' || s.includes(':'));
  if (unsafe) throw bad(`entry ${JSON.stringify(name)}`);
  return parts;
}

/** Write a worker zip's files into `dest` (spec 05c 4.2): every entry is checked before the first file is written. */
export function extractWorkerZip(buf: Buffer, dest: string): void {
  const entries = readZip(buf).map((e) => ({ ...e, parts: partsOf(e.name) }));
  for (const e of entries) {
    const file = join(dest, ...e.parts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, e.data, { mode: e.mode & 0o111 ? 0o755 : 0o644 });
  }
}
