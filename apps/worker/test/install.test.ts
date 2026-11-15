import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/commands/context.js';
import { writeWorkerDir } from './bundle-fixture.js';
import { testPaths, useTempDir, writeEchoPack } from './helpers.js';

const tmp = useTempDir();

function installCli(script: string) {
  const lines: string[] = [];
  let userPath: string | null = 'C:\a';
  const ctx: Ctx = {
    paths: testPaths(tmp()),
    out: (l) => lines.push(l),
    signal: new AbortController().signal,
    env: {},
    script,
    pathDeps: {
      platform: 'win32',
      readUserPath: () => ({ value: userPath, kind: 'ExpandString' }),
      writeUserPath: (v) => {
        userPath = v;
      },
    },
  };
  const run = async (...argv: string[]) => {
    lines.length = 0;
    return { code: await runCli(argv, ctx), text: lines.join('\n') };
  };
  return { ctx, run, userPath: () => userPath };
}

describe('fornax install', () => {
  test('copies the unzipped worker to <data>/app, adds it to Path and says what to do next', async () => {
    const zipDir = writeWorkerDir(join(tmp(), 'fornax-worker'), { version: '0.3.0' });
    const { ctx, run, userPath } = installCli(join(zipDir, 'fornax.mjs'));
    const r = await run('install');
    expect(r.code).toBe(0);
    expect(readFileSync(join(ctx.paths.appDir, 'VERSION'), 'utf8')).toBe('0.3.0\n');
    expect(r.text).toContain(`installed fornax 0.3.0 in ${ctx.paths.appDir}`);
    expect(r.text).toContain(`added ${ctx.paths.appDir} to your Path`);
    expect(r.text).toContain('next: fornax worker pair --server <url> --name <name> (in a new terminal)');
    expect(userPath()).toBe(`C:\a;${ctx.paths.appDir}`);
  });

  test('run from the installed copy: says it is installed and only checks Path', async () => {
    const { ctx, run } = installCli('');
    writeWorkerDir(ctx.paths.appDir, { version: '0.3.0' });
    ctx.script = join(ctx.paths.appDir, 'fornax.mjs');
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, 'server: https://fornax.example.com\n');
    const r = await run('install');
    expect(r.code).toBe(0);
    expect(r.text).toContain(`fornax 0.3.0 is installed in ${ctx.paths.appDir}`);
    expect(r.text).toContain('next: fornax worker (in a new terminal); the folder you unzipped can be deleted');
  });

  test('installed built-in packs are brought up to the new ones when no worker runs', async () => {
    const zipDir = writeWorkerDir(join(tmp(), 'fornax-worker'), { version: '0.3.0' });
    writeEchoPack(join(zipDir, 'types'));
    writeFileSync(join(zipDir, 'types', 'echo', 'scripts', 'tool.mjs'), '// shipped\n');
    const { ctx, run } = installCli(join(zipDir, 'fornax.mjs'));
    writeEchoPack(ctx.paths.typesDir);
    const r = await run('install');
    expect(r.code).toBe(0);
    expect(r.text).toContain('updated type echo');
    expect(readFileSync(join(ctx.paths.typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).toBe('// shipped\n');
  });

  test('a folder that is not an unzipped worker is refused', async () => {
    const { run, ctx } = installCli(join(tmp(), 'fornax.mjs'));
    const r = await run('install');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/is not an unzipped fornax worker/);
    expect(existsSync(ctx.paths.appDir)).toBe(false);
  });
});
