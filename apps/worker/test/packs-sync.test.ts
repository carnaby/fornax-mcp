import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { lockWorker } from '../src/instance.js';
import { InstallError } from '../src/install/errors.js';
import { ORIGIN_FILE, syncPacksUnderLock, syncShippedPacks, writeOrigin } from '../src/install/packs.js';
import { writeSecret } from '../src/secrets.js';
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
  const sync = () => syncShippedPacks({ shippedDir, typesDir, secretsDir: join(root, 'config', 'secrets'), tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal });
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

  test('a setup that failed (or was cut short) stays pending: the next sync runs it again with equal files, and its success clears it', async () => {
    const { root, shippedDir, typesDir, out, sync } = setup();
    const marker = () => JSON.parse(readFileSync(join(typesDir, 'echo', ORIGIN_FILE), 'utf8')) as unknown;
    // Fails until the flag file exists. No braces in it: every {…} in type.yaml is a symbol.
    const flag = join(root, 'setup-may-pass');
    const setupScript = `const fs=require('fs');fs.existsSync(${JSON.stringify(flag)})||process.exit(3);fs.existsSync('env')||fs.mkdirSync('env');fs.writeFileSync('env/ran','1')`;
    writeEchoPack(shippedDir, { setup: ['{tool.node}', '-e', setupScript] });
    writeFileSync(join(shippedDir, 'echo', 'type.yaml'), readFileSync(join(shippedDir, 'echo', 'type.yaml'), 'utf8').replace('version: 1', 'version: 2'));
    await sync();
    expect(out.some((l) => l.startsWith('WARN  echo: setup failed (exit code 3'))).toBe(true);
    expect(marker()).toEqual({ source: 'shipped', setup: 'pending' });

    writeFileSync(flag, '');
    out.length = 0;
    await sync();
    expect(out[0]).toBe('running the setup of echo…');
    expect(out).not.toContain('updated type echo');
    expect(out.filter((l) => l.startsWith('WARN'))).toEqual([]);
    expect(existsSync(join(typesDir, 'echo', 'env', 'ran'))).toBe(true);
    expect(marker()).toEqual({ source: 'shipped' });

    out.length = 0;
    await sync();
    expect(out).toEqual([]);
  });

  test('equal files without a pending setup run no setup', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    const setupScript = "const fs=require('fs');fs.existsSync('env')||fs.mkdirSync('env');fs.writeFileSync('env/ran','1')";
    for (const dir of [shippedDir, typesDir]) writeEchoPack(dir, { setup: ['{tool.node}', '-e', setupScript] });
    writeOrigin(join(typesDir, 'echo'), 'shipped');
    await sync();
    expect(out).toEqual([]);
    expect(existsSync(join(typesDir, 'echo', 'env', 'ran'))).toBe(false);
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
    await syncShippedPacks({ shippedDir, typesDir, secretsDir: join(tmp(), 'secrets'), tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal, copy });
    expect(out).toEqual(['WARN  echo: could not be brought up to date (EBUSY)', 'updated type other']);
    expect(readFileSync(join(typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).not.toBe('// new tool\n');
    expect(readFileSync(join(typesDir, 'echo', 'env', 'marker'), 'utf8')).toBe('venv');
    expect(readFileSync(join(typesDir, 'other', 'scripts', 'tool.mjs'), 'utf8')).toBe('// new tool\n');
  });

  test('a busy swap: env/ goes back into the pack, the stage goes, one WARN', async () => {
    const { shippedDir, typesDir, out } = setup();
    mkdirSync(join(typesDir, 'echo', 'env'));
    writeFileSync(join(typesDir, 'echo', 'env', 'marker'), 'venv');
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'tool.mjs'), '// new tool\n');
    const swap = (_stage: string, target: string) => {
      throw new InstallError(`${target} could not be replaced (EBUSY): a program holds a file in it`);
    };
    await syncShippedPacks({ shippedDir, typesDir, secretsDir: join(tmp(), 'secrets'), tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal, swap });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^WARN {2}echo: .*could not be replaced \(EBUSY\)/);
    expect(readFileSync(join(typesDir, 'echo', 'env', 'marker'), 'utf8')).toBe('venv');
    expect(existsSync(join(typesDir, 'echo.new'))).toBe(false);
  });

  test('a swap whose old pack could not be put back: both halves stay, and the next sync joins them again', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    mkdirSync(join(typesDir, 'echo', 'env'));
    writeFileSync(join(typesDir, 'echo', 'env', 'marker'), 'venv');
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'tool.mjs'), '// new tool\n');
    // What swapDir leaves then: <name> missing, <name>.old the old pack, the stage (with env/) untouched.
    const swap = (_stage: string, target: string) => {
      renameSync(target, `${target}.old`);
      throw new InstallError(`${target} could not be replaced and the old one could not be put back (EPERM): rename ${target}.old to ${target} by hand`);
    };
    await syncShippedPacks({ shippedDir, typesDir, secretsDir: join(tmp(), 'secrets'), tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal, swap });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^WARN {2}echo: .*could not be put back/);
    expect(existsSync(join(typesDir, 'echo'))).toBe(false);
    expect(existsSync(join(typesDir, 'echo.old', 'type.yaml'))).toBe(true);
    expect(readFileSync(join(typesDir, 'echo.new', 'env', 'marker'), 'utf8')).toBe('venv');

    out.length = 0;
    await sync();
    expect(out).toEqual(['updated type echo']);
    expect(readFileSync(join(typesDir, 'echo', 'env', 'marker'), 'utf8')).toBe('venv');
    expect(readFileSync(join(typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).toBe('// new tool\n');
    expect(existsSync(join(typesDir, 'echo.old'))).toBe(false);
    expect(existsSync(join(typesDir, 'echo.new'))).toBe(false);
  });

  test('a lone <name>.old that cannot be put back is a WARN, and the pack is not offered as a new type', async () => {
    const { typesDir, shippedDir, out } = setup();
    renameSync(join(typesDir, 'echo'), join(typesDir, 'echo.old'));
    const rename = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    await syncShippedPacks({ shippedDir, typesDir, secretsDir: join(tmp(), 'secrets'), tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal, rename });
    expect(out).toEqual(['WARN  echo: echo.old could not be put back (EPERM); rename it by hand']);
    expect(existsSync(join(typesDir, 'echo.old', 'type.yaml'))).toBe(true);
  });

  test('a setup run by the sync gets the declared secret (spec 08 § 4.2)', async () => {
    const { root, shippedDir, typesDir, out } = setup();
    const secretsDir = join(root, 'config', 'secrets');
    writeSecret(secretsDir, 'EXAMPLE_TOKEN', 'hf_test_value_123');
    const setupJs = [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "mkdirSync('env', { recursive: true });",
      "writeFileSync('env/got.txt', process.env.EXAMPLE_TOKEN ?? 'none');",
    ].join('\n');
    writeEchoPack(shippedDir, { setup: ['{tool.node}', '{pack}/scripts/setup.mjs'], secrets: ['EXAMPLE_TOKEN'] });
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'setup.mjs'), setupJs);
    await syncShippedPacks({ shippedDir, typesDir, secretsDir, tools: NODE_TOOLS, out: (l) => out.push(l), signal: new AbortController().signal });
    expect(readFileSync(join(typesDir, 'echo', 'env', 'got.txt'), 'utf8')).toBe('hf_test_value_123');
  });

  test('a changed secrets list runs the setup again (spec 08 § 4.1)', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    const setupJs = "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('env', { recursive: true });\nwriteFileSync('env/ran', '1');\n";
    for (const dir of [shippedDir, typesDir]) {
      writeEchoPack(dir, { setup: ['{tool.node}', '{pack}/scripts/setup.mjs'] });
      writeFileSync(join(dir, 'echo', 'scripts', 'setup.mjs'), setupJs);
    }
    writeEchoPack(shippedDir, { setup: ['{tool.node}', '{pack}/scripts/setup.mjs'], secrets: ['EXAMPLE_TOKEN'] });
    await sync();
    expect(out.slice(0, 2)).toEqual(['updated type echo', 'running the setup of echo…']);
    expect(existsSync(join(typesDir, 'echo', 'env', 'ran'))).toBe(true);
  });

  test('the setup runs again only when a file it runs changed, not for another script', async () => {
    const { shippedDir, typesDir, out, sync } = setup();
    const setupJs = "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('env', { recursive: true });\nwriteFileSync('env/ran', '1');\n";
    for (const dir of [shippedDir, typesDir]) {
      writeEchoPack(dir, { setup: ['{tool.node}', '{pack}/scripts/setup.mjs'] });
      writeFileSync(join(dir, 'echo', 'scripts', 'setup.mjs'), setupJs);
    }
    const ran = join(typesDir, 'echo', 'env', 'ran');

    // Same version, setup argv and setup.mjs; only the tool changed: replaced, no setup.
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'tool.mjs'), '// new tool\n');
    await sync();
    expect(out).toEqual(['updated type echo']);
    expect(readFileSync(join(typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).toBe('// new tool\n');
    expect(existsSync(ran)).toBe(false);

    // Same version, the setup file changed: the setup runs.
    writeFileSync(join(shippedDir, 'echo', 'scripts', 'setup.mjs'), `// a new model\n${setupJs}`);
    out.length = 0;
    await sync();
    expect(out.slice(0, 2)).toEqual(['updated type echo', 'running the setup of echo…']);
    expect(existsSync(ran)).toBe(true);
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
