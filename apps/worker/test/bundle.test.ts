import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { FORNAX_VERSION } from '@fornax/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const script = fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url));
let out: string;

/** The entries of a zip, read through its central directory; every entry's size and CRC-32 are checked. */
function readZip(buf: Buffer): Map<string, { data: Buffer; mode: number }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = new Map<string, { data: Buffer; mode: number }>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const attributes = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length, name).toBe(size);
    expect(crc32(data), name).toBe(crc);
    entries.set(name, { data, mode: (attributes >>> 16) & 0o777 });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'fornax-bundle-'));
  const r = spawnSync(process.execPath, [script, out], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('the worker bundle', () => {
  test('the zip holds the CLI, launchers, licence and the built-in packs, and nothing that is not shipped', () => {
    const zip = join(out, `fornax-worker-${FORNAX_VERSION}.zip`);
    const entries = readZip(readFileSync(zip));
    const names = [...entries.keys()];
    for (const name of [
      'fornax.mjs', 'fornax.cmd', 'fornax', 'LICENSE', 'types/README.md',
      'types/transcribe/type.yaml', 'types/transcribe/setup.md', 'types/transcribe/scripts/run.py',
      'types/render/type.yaml', 'types/render/scripts/render.py',
      'types/lease/type.yaml', 'types/lease/setup.md', 'types/lease/scripts/lease.mjs', 'types/lease/scripts/check.mjs',
    ]) {
      expect(names, name).toContain(`fornax-worker/${name}`);
    }
    expect(names.every((n) => n.startsWith('fornax-worker/'))).toBe(true);
    expect(names.filter((n) => /\/(tests|__pycache__|env)\//.test(n))).toEqual([]);
    expect(entries.get('fornax-worker/fornax')!.mode).toBe(0o755);
    expect(entries.get('fornax-worker/fornax.mjs')!.mode).toBe(0o644);
    expect(entries.get('fornax-worker/types/render/type.yaml')!.data.toString('utf8')).toContain('name: render');
  });

  test('the zip holds VERSION with the version on one line', () => {
    const entries = readZip(readFileSync(join(out, `fornax-worker-${FORNAX_VERSION}.zip`)));
    expect(entries.get('fornax-worker/VERSION')?.data.toString('utf8')).toBe(`${FORNAX_VERSION}\n`);
  });

  test('the bundled CLI runs on its own and prints its version', () => {
    const r = spawnSync(process.execPath, [join(out, 'fornax-worker', 'fornax.mjs'), '--version'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(FORNAX_VERSION);
  });

  test('the bundled CLI finds the packs shipped next to it', () => {
    const home = mkdtempSync(join(tmpdir(), 'fornax-bundle-home-'));
    try {
      const env = { ...process.env, FORNAX_DATA_DIR: join(home, 'data'), FORNAX_CONFIG_DIR: join(home, 'config') };
      const r = spawnSync(process.execPath, [join(out, 'fornax-worker', 'fornax.mjs'), 'types', 'install', 'render'], { encoding: 'utf8', env });
      // render has no setup; without blender in worker.yaml it is installed but not ready (exit 1).
      expect(r.stdout).toContain('installed render in');
      expect(existsSync(join(home, 'data', 'types', 'render', 'type.yaml'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
