import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import type { Ctx } from '../src/commands/context.js';
import { workerCommand } from '../src/commands/worker.js';
import { saveToken } from '../src/config.js';
import { restartCheck, writeRestartRequest } from '../src/restart.js';
import { writeWorkerDir } from './bundle-fixture.js';
import { testPaths, useTempDir, writeEchoPack } from './helpers.js';

const tmp = useTempDir();

describe('restartCheck', () => {
  test('another version, installed copy: restart, the request is removed, one line', () => {
    const paths = testPaths(tmp());
    const out: string[] = [];
    const check = restartCheck(paths, { version: '0.3.0', installed: true, out: (l) => out.push(l) });
    expect(check()).toBe(false);
    writeRestartRequest(paths, '0.4.0');
    expect(check()).toBe(true);
    expect(out).toEqual(['restarting for fornax 0.4.0']);
    expect(existsSync(paths.restartFile)).toBe(false);
  });

  test('the version this worker already is: removed, no restart', () => {
    const paths = testPaths(tmp());
    writeRestartRequest(paths, '0.3.0');
    expect(restartCheck(paths, { version: '0.3.0', installed: true, out: () => {} })()).toBe(false);
    expect(existsSync(paths.restartFile)).toBe(false);
  });

  test('a copy outside app does not restart; it says so once and leaves the request (Review Focus 5)', () => {
    const paths = testPaths(tmp());
    const out: string[] = [];
    writeRestartRequest(paths, '0.4.0');
    const check = restartCheck(paths, { version: '0.3.0', installed: false, out: (l) => out.push(l) });
    expect(check()).toBe(false);
    expect(check()).toBe(false);
    expect(out).toEqual([`fornax 0.4.0 is installed in ${paths.appDir}; this worker runs from another folder: stop it and run fornax worker`]);
    expect(existsSync(paths.restartFile)).toBe(true);
  });

  test('a damaged restart file is removed (Review Focus 3)', () => {
    const paths = testPaths(tmp());
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.restartFile, 'not json');
    expect(restartCheck(paths, { version: '0.3.0', installed: true, out: () => {} })()).toBe(false);
    expect(existsSync(paths.restartFile)).toBe(false);
  });
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('fornax worker --child at start', () => {
  test('an installed copy brings the packs up to its shipped ones; a pack sync that throws does not stop the worker (Review Focus 4)', async () => {
    const s = await startTestServer();
    closers.push(() => s.close());
    const paths = testPaths(tmp());
    writeWorkerDir(paths.appDir, { version: '0.3.0' });
    writeEchoPack(join(paths.appDir, 'types'));
    writeFileSync(join(paths.appDir, 'types', 'echo', 'scripts', 'tool.mjs'), '// shipped\n');
    writeEchoPack(paths.typesDir);
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, `server: ${s.url}\ntools:\n  node: ${JSON.stringify(process.execPath)}\n`);
    saveToken(paths, s.issueToken('pc', 'worker'));
    const out: string[] = [];
    const ctx: Ctx = { paths, out: (l) => out.push(l), signal: new AbortController().signal, env: {}, script: join(paths.appDir, 'fornax.mjs'), loopOptions: { claimWaitS: 0, checkTimeoutMs: 10_000 } };
    expect(await workerCommand(ctx, true, { child: true })).toBe(0);
    expect(out).toContain('updated type echo');

    // A sync that throws (a file in use, a disk error): one WARN, the worker still starts and offers echo.
    out.length = 0;
    const failing = async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    expect(await workerCommand(ctx, true, { child: true, syncPacks: failing })).toBe(0);
    expect(out).toContain('WARN  the installed types could not be brought up to date (EBUSY); the worker starts with them as they are');
    expect(out).toContain('offering: echo');
  });
});
