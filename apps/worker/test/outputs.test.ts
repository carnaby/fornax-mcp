import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { collectOutputs, OutputError } from '../src/outputs.js';
import { useTempDir } from './helpers.js';

const tmp = useTempDir();

function outDir(files: Record<string, string>): string {
  const out = join(tmp(), 'out');
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(out, ...name.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return out;
}

describe('collectOutputs', () => {
  test('every file, nested names with "/", outputs.json read and not listed', async () => {
    const out = outDir({
      'frame_0001.png': 'PNG',
      'previews/frame_0001.jpg': 'JPG',
      'data/a/b.json': '{}',
      'outputs.json': JSON.stringify({ 'frame_0001.png': { meta: { width: 1920 }, preview: 'previews/frame_0001.jpg' } }),
    });
    const r = await collectOutputs(out);
    expect(r.files.map((f) => [f.name, f.size])).toEqual([['data/a/b.json', 2], ['frame_0001.png', 3], ['previews/frame_0001.jpg', 3]]);
    expect(r.files[1]!.path).toBe(join(out, 'frame_0001.png'));
    expect(r.info).toEqual({ 'frame_0001.png': { meta: { width: 1920 }, preview: 'previews/frame_0001.jpg' } });
  });

  test('an empty output directory is fine', async () => {
    expect(await collectOutputs(outDir({}))).toEqual({ files: [], info: {} });
  });

  test('a link inside out/ pointing outside is refused, never followed', async () => {
    const secret = join(tmp(), 'secret');
    mkdirSync(secret);
    writeFileSync(join(secret, 'key.txt'), 'do not upload');
    const out = outDir({ 'ok.txt': 'x' });
    // A junction needs no privileges on Windows; on Linux the type is ignored and a directory symlink is made.
    symlinkSync(secret, join(out, 'leak'), 'junction');
    const e = await collectOutputs(out).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OutputError);
    expect((e as Error).message).toMatch(/out\/leak/);
  });

  test('names the server would refuse fail here, naming the file', async () => {
    await expect(collectOutputs(outDir({ '.hidden': 'x' }))).rejects.toThrow(/out\/\.hidden/);
    await expect(collectOutputs(outDir({ 'with space.txt': 'x' }))).rejects.toThrow(/with space/);
    await expect(collectOutputs(outDir({ 'with space.txt': 'x' }))).rejects.toThrow(/ASCII letters, digits/);
  });

  test.skipIf(process.platform === 'win32')('device names and case twins are refused (they cannot both exist on Windows)', async () => {
    await expect(collectOutputs(outDir({ 'nul.txt': 'x' }))).rejects.toThrow(/nul\.txt/);
    await expect(collectOutputs(outDir({ 'A.png': '1', 'a.png': '2' }))).rejects.toThrow(/differ only in letter case/);
  });

  test('log.txt is reserved for the job log', async () => {
    await expect(collectOutputs(outDir({ 'LOG.txt': 'x' }))).rejects.toThrow(/reserved for the job log/);
  });

  test('outputs.json must be valid and name only files that exist', async () => {
    await expect(collectOutputs(outDir({ 'a.png': 'x', 'outputs.json': '{' }))).rejects.toThrow(/not valid JSON/);
    await expect(collectOutputs(outDir({ 'a.png': 'x', 'outputs.json': '{"b.png": {}}' }))).rejects.toThrow(/b\.png, which is not in out/);
    await expect(collectOutputs(outDir({ 'a.png': 'x', 'outputs.json': '{"a.png": {"preview": "p.jpg"}}' }))).rejects.toThrow(/preview p\.jpg/);
    await expect(collectOutputs(outDir({ 'a.png': 'x', 'outputs.json': '{"a.png": {"preview": "a.png"}}' }))).rejects.toThrow(/its own preview/);
    await expect(collectOutputs(outDir({ 'a.png': 'x', 'b.png': 'y', 'outputs.json': '{"a.png": {"preview": "b.png"}, "b.png": {"meta": {"w": 1}}}' }))).rejects.toThrow(/preview b\.png of a\.png.*separate file/);
    await expect(collectOutputs(outDir({ 'a.png': 'x', 'outputs.json': '{"a.png": {"size": 1}}' }))).rejects.toThrow(/outputs\.json/);
  });

  test('outputs.json may hold at most 1 MiB', async () => {
    const at = (bytes: number) => `{}${' '.repeat(bytes - 2)}`;
    expect((await collectOutputs(outDir({ 'a.png': 'x', 'outputs.json': at(1024 * 1024) }))).info).toEqual({});
    const e = await collectOutputs(outDir({ 'a.png': 'x', 'outputs.json': at(1024 * 1024 + 1) })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OutputError);
    expect((e as Error).message).toBe('out/outputs.json is larger than 1 MiB');
  });
});
