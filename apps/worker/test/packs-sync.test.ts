import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { lockWorker } from '../src/instance.js';
import { ORIGIN_FILE, syncPacksUnderLock, syncShippedPacks, writeOrigin } from '../src/install/packs.js';
import { NODE_TOOLS, testPaths, useTempDir, writeEchoPack } from './helpers.js';

const tmp = useTempDir();

/** A shipped types dir and an installed one, each with an echo pack; returns both and a sync runner. */
function setup() {
  const root = tmp();
  const shippedDir = join(root, 'app', 'types');
  const typesDir = join(root, 'data', 'types');
  mkdirSync(shippedDir, { recursive: true });
  writeFileSync(join(shippedDir, 'README.md'), '# packs\n');
  writeEchoPack(shippedDir);
  writeEchoPack(typesDir);
  const out: string[] = [];
  const sync = () => syncShippedPacks({ shippedDir, typesDir, tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal });
  return { root, shippedDir, typesDir, out, sync };
}

describe('syncShippedPacks', () => {
  test('equal files: nothing changes, a pack from before 0.3.0 gets its marker', async () => {
    const { typesDir, out, sync } = setup();
    const before = statSync(join(typesDir, 'echo', 'type.yaml')).mtimeMs;
    await sync();
    expect(out).toEqual([]);
    expect(statSync(join(typesDir, 'echo', 'type.yaml')).mtimeMs).toBe(before);
    expect(JSON.parse(readFileSync(join(typesDir, 'echo', ORIGIN_FILE), 'utf8'))).toEqual({ source: 'shipped' });
  });

  test('changed scripts: replaced, env/ kept, type.yaml touched so a running loop reloads', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'tool.mjs'), '// new tool\n');
    mkdirSync(join(typesDir, 'echo', 'env'), { recursive: true });
    writeFileSync(join(typesDir, 'echo', 'env', 'marker'), 'venv');
    const before = statSync(join(typesDir, 'echo', 'type.yaml')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await sync();
    expect(readFileSync(join(typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).toBe('// new tool\n');
    expect(readFileSync(join(typesDir, 'echo', 'env', 'marker'), 'utf8')).toBe('venv');
    expect(statSync(join(typesDir, 'echo', 'type.yaml')).mtimeMs).toBeGreaterThan(before);
    expect(out).toEqual(['updated type echo']);
  });

  test('a new version or a changed setup script runs the setup again in the same env/; a failing setup is a WARN, the pack stays', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    // The shipped echo gets a setup that writes env/ran and a higher version. No braces in it: every {…} in type.yaml is a symbol.
    const setupScript = "const fs=require('fs');fs.existsSync('env')||fs.mkdirSync('env');fs.writeFileSync('env/ran','1')";
    writeEchoPack(shippedDir, { setup: ['{tool.node}', '-e', setupScript] });
    const yaml = readFileSync(join(shippedDir, 'echo', 'type.yaml'), 'utf8').replace('version: 1', 'version: 2');
    writeFileSync(join(shippedDir, 'echo', 'type.yaml'), yaml);
    await sync();
    expect(existsSync(join(typesDir, 'echo', 'env', 'ran'))).toBe(true);
    expect(out[0]).toBe('updated type echo');

    // A setup that fails: WARN, the pack is still installed.
    writeEchoPack(shippedDir, { setup: ['{tool.node}', '-e', 'process.exit(3)'] });
    writeFileSync(join(shippedDir, 'echo', 'type.yaml'), readFileSync(join(shippedDir, 'echo', 'type.yaml'), 'utf8').replace('version: 1', 'version: 3'));
    out.length = 0;
    await sync();
    expect(out.some((l) => l.startsWith('WARN  echo: setup failed (exit code 3') && l.endsWith('the type is not ready (fornax doctor)'))).toBe(true);
    expect(existsSync(join(typesDir, 'echo', 'type.yaml'))).toBe(true);
  });

  test('a pack installed from a directory is never touched', async () => {
    const { shippedDir, typesDir, sync } = setup();
    writeOrigin(join(typesDir, 'echo'), 'dir');
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'tool.mjs'), '// new tool\n');
    await sync();
    expect(readFileSync(join(typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).not.toBe('// new tool\n');
  });

  test('a shipped pack that is not installed is only mentioned; one no longer shipped gets a WARN', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    writeEchoPack(shippedDir, { name: 'upscale' });
    writeEchoPack(typesDir, { name: 'old' });
    writeOrigin(join(typesDir, 'old'), 'shipped');
    await sync();
    expect(out).toContain('new type upscale: fornax types install upscale');
    expect(out).toContain('WARN  old is no longer shipped');
    expect(existsSync(join(typesDir, 'upscale'))).toBe(false);
  });

  test('an <name>.old next to the pack is not a pack and goes, so does an <name>.new', async () => {
    const { typesDir, out, sync } = setup();
    // What a swap that could not finish leaves next to the pack: an older copy of it, type.yaml included.
    writeEchoPack(join(typesDir, 'leftover'));
    renameSync(join(typesDir, 'leftover', 'echo'), join(typesDir, 'echo.old'));
    writeOrigin(join(typesDir, 'echo.old'), 'shipped');
    writeEchoPack(join(typesDir, 'leftover'));
    renameSync(join(typesDir, 'leftover', 'echo'), join(typesDir, 'echo.new'));
    await sync();
    expect(out).toEqual([]);
    expect(existsSync(join(typesDir, 'echo.old'))).toBe(false);
    expect(existsSync(join(typesDir, 'echo.new'))).toBe(false);
  });

  test('a lone <name>.old (the only copy after a swap that could not be undone) is put back and synced', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    renameSync(join(typesDir, 'echo'), join(typesDir, 'echo.old'));
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'tool.mjs'), '// new tool\n');
    await sync();
    expect(readFileSync(join(typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).toBe('// new tool\n');
    expect(existsSync(join(typesDir, 'echo.old'))).toBe(false);
    expect(out).toEqual(['updated type echo']);
  });

  test("one pack's file error is a WARN; the other packs are still brought up to date", async () => {
    const { shippedDir, typesDir, out } = setup();
    writeEchoPack(shippedDir, { name: 'other' });
    writeEchoPack(typesDir, { name: 'other' });
    mkdirSync(join(typesDir, 'echo', 'env'));
    writeFileSync(join(typesDir, 'echo', 'env', 'marker'), 'venv');
    for (const name of ['echo', 'other']) writeFileSync(join(shippedDir, name, 'scripts', 'tool.mjs'), '// new tool\n');
    const copy = ((src: string, dest: string, opts: object) => {
      if (basename(src) === 'echo') throw Object.assign(new Error(`EBUSY: resource busy, copyfile ${src}`), { code: 'EBUSY' });
      cpSync(src, dest, opts);
    }) as typeof cpSync;
    await syncShippedPacks({ shippedDir, typesDir, tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal, copy });
    expect(out).toEqual(['WARN  echo: could not be brought up to date (EBUSY)', 'updated type other']);
    expect(readFileSync(join(typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).not.toBe('// new tool\n');
    expect(readFileSync(join(typesDir, 'echo', 'env', 'marker'), 'utf8')).toBe('venv');
    expect(readFileSync(join(typesDir, 'other', 'scripts', 'tool.mjs'), 'utf8')).toBe('// new tool\n');
  });
});

describe('syncPacksUnderLock', () => {
  test('a running worker (lock held) leaves the packs to the worker', async () => {
    const paths = testPaths(tmp());
    const { shippedDir } = setup();
    const lock = lockWorker(paths);
    if (!('release' in lock)) throw new Error('no lock');
    // Our own pid in the lock counts as stale for lockWorker: write another live pid (the parent's) to simulate a worker.
    writeFileSync(lock.file, String(process.ppid));
    const r = await syncPacksUnderLock(paths, { shippedDir, tools: NODE_TOOLS, out: () => {}, signal: new AbortController().signal });
    expect(r).toBe('worker-running');
    writeFileSync(lock.file, String(process.pid));
    lock.release();
    expect(await syncPacksUnderLock(paths, { shippedDir, tools: NODE_TOOLS, out: () => {}, signal: new AbortController().signal })).toBe('synced');
  });
});
