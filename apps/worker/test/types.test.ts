import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { typesInstall } from '../src/commands/types.js';
import type { Ctx } from '../src/commands/context.js';
import { testPaths, useTempDir, writeEchoPack } from './helpers.js';

const tmp = useTempDir();

function cli() {
  const lines: string[] = [];
  const copied: string[] = [];
  const ctx: Ctx = {
    paths: testPaths(tmp()),
    out: (l) => lines.push(l),
    signal: new AbortController().signal,
    clipboard: (text) => {
      copied.push(text);
      return 'test-clipboard';
    },
  };
  mkdirSync(ctx.paths.configDir, { recursive: true });
  writeFileSync(ctx.paths.configFile, `server: https://fornax.example.com\ntools:\n  node: ${JSON.stringify(process.execPath)}\n`);
  const run = async (...argv: string[]) => {
    lines.length = 0;
    const code = await runCli(argv, ctx);
    return { code, text: lines.join('\n') };
  };
  return { ctx, run, copied };
}

const SETUP_SCRIPT = [
  "import { mkdirSync, writeFileSync } from 'node:fs';",
  "mkdirSync('env', { recursive: true });",
  "writeFileSync('env/ready.txt', 'ok');",
  "console.log('setup done');",
  "process.exitCode = process.argv[2] === 'fail' ? 1 : 0;",
].join('\n');

/** A pack source with a setup script and a stray env/ that must not be copied. */
function source(setupArg = 'ok'): string {
  const dir = writeEchoPack(tmp(), { setup: ['{tool.node}', '{pack}/scripts/setup.mjs', setupArg] });
  writeFileSync(join(dir, 'scripts', 'setup.mjs'), SETUP_SCRIPT);
  mkdirSync(join(dir, 'env'));
  writeFileSync(join(dir, 'env', 'junk.txt'), 'from another machine');
  return dir;
}

describe('fornax types', () => {
  test('install --from copies the pack without env/, runs its setup and its check', async () => {
    const { ctx, run } = cli();
    const src = source();
    const r = await run('types', 'install', 'echo', '--from', src);
    expect(r.code).toBe(0);
    expect(r.text).toContain('it is ready');
    const dest = join(ctx.paths.typesDir, 'echo');
    expect(readFileSync(join(dest, 'env', 'ready.txt'), 'utf8')).toBe('ok');
    expect(existsSync(join(dest, 'env', 'junk.txt'))).toBe(false);
    expect((await run('types', 'install', 'echo', '--from', src)).code).toBe(1);
    expect((await run('types', 'list')).text).toContain('echo v1  ready');
  });

  test('a failing setup leaves nothing installed', async () => {
    const { ctx, run } = cli();
    const r = await run('types', 'install', 'echo', '--from', source('fail'));
    expect(r.code).toBe(1);
    expect(r.text).toContain('the setup of echo failed (exit code 1): setup done');
    expect(existsSync(join(ctx.paths.typesDir, 'echo'))).toBe(false);
  });

  test('without --from only built-in packs install', async () => {
    const { run } = cli();
    const r = await run('types', 'install', 'nothing-like-this');
    expect(r.code).toBe(1);
    expect(r.text).toContain('there is no built-in type pack nothing-like-this');
  });

  test('add makes a skeleton that is not offered yet and hands Claude the prompt', async () => {
    const { ctx, run, copied } = cli();
    const r = await run('types', 'add', 'upscale');
    expect(r.code).toBe(0);
    const dir = join(ctx.paths.typesDir, 'upscale');
    for (const f of ['type.yaml', 'setup.md', 'scripts']) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain(dir);
    expect(copied[0]).toContain('# Fornax type packs');
    expect(r.text).toContain('test-clipboard');
    expect((await run('types', 'list')).text).toMatch(/type pack upscale: [\s\S]*run/);
    expect((await run('types', 'add', 'upscale')).code).toBe(1);
  });

  test('invalid names are refused by add and install', async () => {
    const { run } = cli();
    for (const bad of ['Bad_Name', '../x']) {
      expect((await run('types', 'add', bad)).code, bad).toBe(2);
      expect((await run('types', 'install', bad, '--from', source())).code, bad).toBe(2);
    }
  });

  test('a copy that fails midway leaves nothing and says so', async () => {
    const { ctx } = cli();
    const lines: string[] = [];
    ctx.out = (l) => lines.push(l);
    const code = await typesInstall(ctx, 'echo', source(), {
      copy: (src, dest, o) => {
        cpSync(src, dest, o);
        throw Object.assign(new Error('secret local path'), { code: 'EIO' });
      },
    });
    expect(code).toBe(1);
    expect(existsSync(join(ctx.paths.typesDir, 'echo'))).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('installing echo failed (Error, EIO)');
    expect(text).not.toContain('secret local path');
  });

  test('when the failed copy cannot be removed, the real failure and the directory are named', async () => {
    const { ctx } = cli();
    const lines: string[] = [];
    ctx.out = (l) => lines.push(l);
    const code = await typesInstall(ctx, 'echo', source('fail'), {
      remove: () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    });
    const text = lines.join('\n');
    expect(code).toBe(1);
    expect(text).toContain('the setup of echo failed (exit code 1)');
    expect(text).toContain(`${join(ctx.paths.typesDir, 'echo')} could not be removed`);
  });

  test('a link inside the source pack is refused before anything is copied', async () => {
    const { ctx, run } = cli();
    const src = source();
    try {
      symlinkSync(process.execPath, join(src, 'scripts', 'sneaky'), 'file');
    } catch {
      return; // no permission to create links on this machine
    }
    const r = await run('types', 'install', 'echo', '--from', src);
    expect(r.code).toBe(1);
    expect(r.text).toContain(join('scripts', 'sneaky'));
    expect(existsSync(join(ctx.paths.typesDir, 'echo'))).toBe(false);
  });

  test('a source that contains the types directory, or lies inside it, is refused', async () => {
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.typesDir, { recursive: true });
    const inside = writeEchoPack(ctx.paths.typesDir, { name: 'other' });
    const parent = join(ctx.paths.typesDir, '..');
    copyFileSync(join(inside, 'type.yaml'), join(parent, 'type.yaml'));
    for (const from of [inside, parent]) {
      const r = await run('types', 'install', 'other', '--from', from);
      expect(r.code, from).toBe(1);
      expect(r.text).toContain('must not contain one another');
    }
  });
});
