import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

/**
 * Spec 14 § 4.2: a ZIP without compression (method 0), written as a stream. Sizes are known ahead (the database has
 * them), so the whole length is too; CRC-32 is computed while the data passes and follows each file in a data
 * descriptor (flag bit 3), as Go's archive/zip does. Names are UTF-8 (flag bit 11). ZIP64 records are written for the
 * whole archive when a file or an offset reaches 4 GiB or there are 65 535 entries or more.
 */
export type ZipEntry = { name: string; size: number; open: () => Readable };

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0808; // bit 3: data descriptor; bit 11: UTF-8 names
const LOCAL = 30;
const CENTRAL = 46;
const END = 22;
const END64 = 56;
const LOCATOR = 20;

const nameBytes = (e: ZipEntry) => Buffer.byteLength(e.name, 'utf8');
const descriptorBytes = (z: boolean) => (z ? 24 : 16);
const centralExtra = (z: boolean) => (z ? 28 : 0);

/** Offsets of each local header and of the central directory, and the central directory's size. */
function layout(entries: ZipEntry[], z: boolean) {
  const offsets: number[] = [];
  let at = 0;
  for (const e of entries) {
    offsets.push(at);
    at += LOCAL + nameBytes(e) + e.size + descriptorBytes(z);
  }
  const central = entries.reduce((sum, e) => sum + CENTRAL + nameBytes(e) + centralExtra(z), 0);
  return { offsets, centralOffset: at, centralSize: central };
}

export function needsZip64(entries: ZipEntry[]): boolean {
  if (entries.length >= MAX16) return true;
  if (entries.some((e) => e.size >= MAX32)) return true;
  const { offsets, centralOffset, centralSize } = layout(entries, false);
  return offsets.some((o) => o >= MAX32) || centralOffset >= MAX32 || centralSize >= MAX32;
}

export function zipSize(entries: ZipEntry[], opts: { zip64?: boolean } = {}): number {
  const z = opts.zip64 ?? needsZip64(entries);
  const { centralOffset, centralSize } = layout(entries, z);
  return centralOffset + centralSize + END + (z ? END64 + LOCATOR : 0);
}

/** DOS date and time of `d` in UTC (ZIP has no time zone); before 1980 it is 1980-01-01. */
function dosTime(d: Date): { time: number; date: number } {
  if (d.getUTCFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function zipStream(entries: ZipEntry[], modified: Date, opts: { zip64?: boolean } = {}): Readable {
  const z = opts.zip64 ?? needsZip64(entries);
  const { offsets, centralOffset, centralSize } = layout(entries, z);
  const { time, date } = dosTime(modified);
  const version = z ? 45 : 20;
  const crcs: number[] = [];

  async function* bytes(): AsyncGenerator<Buffer> {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      const local = Buffer.alloc(LOCAL);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(version, 4);
      local.writeUInt16LE(FLAGS, 6);
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      // CRC and sizes are 0 here: the data descriptor carries them (bit 3).
      local.writeUInt16LE(name.length, 26);
      yield Buffer.concat([local, name]);
      let crc = 0;
      let size = 0;
      for await (const chunk of e.open()) {
        const b = chunk as Buffer;
        crc = crc32(b, crc);
        size += b.length;
        yield b;
      }
      if (size !== e.size) throw new Error(`${e.name} has ${size} bytes, not ${e.size}`);
      crcs.push(crc);
      const d = Buffer.alloc(descriptorBytes(z));
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      if (z) {
        d.writeBigUInt64LE(BigInt(size), 8);
        d.writeBigUInt64LE(BigInt(size), 16);
      } else {
        d.writeUInt32LE(size, 8);
        d.writeUInt32LE(size, 12);
      }
      yield d;
    }
    const central: Buffer[] = [];
    entries.forEach((e, i) => {
      const name = Buffer.from(e.name, 'utf8');
      const h = Buffer.alloc(CENTRAL);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(version, 4); // made by
      h.writeUInt16LE(version, 6); // needed
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(crcs[i]!, 16);
      h.writeUInt32LE(z ? MAX32 : e.size, 20);
      h.writeUInt32LE(z ? MAX32 : e.size, 24);
      h.writeUInt16LE(name.length, 28);
      h.writeUInt16LE(centralExtra(z), 30);
      h.writeUInt32LE(z ? MAX32 : offsets[i]!, 42);
      const parts = [h, name];
      if (z) {
        const x = Buffer.alloc(28);
        x.writeUInt16LE(0x0001, 0);
        x.writeUInt16LE(24, 2);
        x.writeBigUInt64LE(BigInt(e.size), 4);
        x.writeBigUInt64LE(BigInt(e.size), 12);
        x.writeBigUInt64LE(BigInt(offsets[i]!), 20);
        parts.push(x);
      }
      central.push(Buffer.concat(parts));
    });
    yield Buffer.concat(central);
    if (z) {
      const r = Buffer.alloc(END64);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(BigInt(END64 - 12), 4);
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(entries.length), 24);
      r.writeBigUInt64LE(BigInt(entries.length), 32);
      r.writeBigUInt64LE(BigInt(centralSize), 40);
      r.writeBigUInt64LE(BigInt(centralOffset), 48);
      const l = Buffer.alloc(LOCATOR);
      l.writeUInt32LE(0x07064b50, 0);
      l.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
      l.writeUInt32LE(1, 16);
      yield Buffer.concat([r, l]);
    }
    const end = Buffer.alloc(END);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(z ? MAX16 : entries.length, 8);
    end.writeUInt16LE(z ? MAX16 : entries.length, 10);
    end.writeUInt32LE(z ? MAX32 : centralSize, 12);
    end.writeUInt32LE(z ? MAX32 : centralOffset, 16);
    yield end;
  }

  return Readable.from(bytes(), { objectMode: false });
}
