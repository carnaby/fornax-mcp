import { open } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';

/** Blender before the large-file header: "BLENDER", pointer size (_ or -), endianness (v or V), version "503" = 5.3. */
const OLD_HEADER = /^BLENDER[_-][vV](\d)(\d\d)/;
/** The 17-byte header: "BLENDER", header size "17", "-", format "01", endianness, version "0503" = 5.3. */
const NEW_HEADER = /^BLENDER\d\d-\d\d[vV](\d\d)(\d\d)/;
const HEADER_BYTES = 17;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** A compressed .blend: this much of the file is enough to reach the header inside. */
const ZSTD_READ_BYTES = 64 * 1024;

/** Spec 14 § 3.1: the Blender version that saved a .blend, from its first bytes ("5.3"); null when they are no header. */
export function blendVersion(head: Buffer): string | null {
  const text = head.subarray(0, HEADER_BYTES).toString('latin1');
  const m = NEW_HEADER.exec(text) ?? OLD_HEADER.exec(text);
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

/** The start of a zstd stream, decompressed until the header is there; null when nothing comes out. Never throws. */
function zstdHead(compressed: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const z = createZstdDecompress();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      z.destroy();
      resolve(value);
    };
    z.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= HEADER_BYTES) settle(Buffer.concat(chunks));
    });
    // The stream is cut after ZSTD_READ_BYTES: an "unexpected end" after the header is no failure.
    z.on('error', () => settle(size > 0 ? Buffer.concat(chunks) : null));
    z.on('end', () => settle(size > 0 ? Buffer.concat(chunks) : null));
    z.end(compressed);
  });
}

/** The version of a stored .blend file, plain or zstd-compressed; null for anything else or on any read error. */
export async function blendFileVersion(path: string): Promise<string | null> {
  try {
    const fh = await open(path, 'r');
    let head: Buffer;
    try {
      const buf = Buffer.alloc(ZSTD_READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    if (head.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
      const inner = await zstdHead(head);
      return inner ? blendVersion(inner) : null;
    }
    return blendVersion(head);
  } catch {
    return null;
  }
}
