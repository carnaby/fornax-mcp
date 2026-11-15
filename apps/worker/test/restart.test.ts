import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startTestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import type { Ctx } from '../src/commands/context.js';
import { workerCommand } from '../src/commands/worker.js';
import { saveToken } from '../src/config.js';
import { lockWorker } from '../src/instance.js';
import type { Paths } from '../src/paths.js';
import { readRestartRequest, restartCheck, writeRestartRequest } from '../src/restart.js';
import { writeWorkerDir } from './bundle-fixture.js';
import { testPaths, useTempDir, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const RUNS_FROM = 'elsewhere';

describe('restartCheck', () => {
  test('another version, installed copy: restart, the request is removed, one line', () => {
    const paths = testPaths(tmp());
    const out: string[] = [];
    const check = restartCheck(paths, { version: '0.3.0', installed: true, runsFrom: RUNS_FROM, out: (l) => out.push(l) });
    expect(check()).toBe(false);
    writeRestartRequest(paths, '0.4.0');
    expect(check()).toBe(true);
    expect(out).toEqual(['restarting for fornax 0.4.0']);
    expect(existsSync(paths.restartFile)).toBe(false);
  });

  test('the version this worker already is: removed, no restart', () => {
    const paths = testPaths(tmp());
    writeRestartRequest(paths, '0.3.0');
    expect(restartCheck(paths, { version: '0.3.0', installed: true, runsFrom: RUNS_FROM, out: () => {} })()).toBe(false);
    expect(existsSync(paths.restartFile)).toBe(false);
  });

  test('a copy outside app does not restart; it says so once and leaves the request (Review Focus 5)', () => {
    const paths = testPaths(tmp());
    const out: string[] = [];
    writeRestartRequest(paths, '0.4.0');
    const check = restartCheck(paths, { version: '0.3.0', installed: false, runsFrom: RUNS_FROM, out: (l) => out.push(l) });
    expect(check()).toBe(false);
    expect(check()).toBe(false);
    expect(out).toEqual([`fornax 0.4.0 is installed in ${paths.appDir}; this worker runs from ${RUNS_FROM}: stop it and run fornax worker`]);
    expect(existsSync(paths.restartFile)).toBe(true);
  });

  test('a damaged restart file is removed (Review Focus 3)', () => {
    const paths = testPaths(tmp());
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.restartFile, 'not json');
    expect(restartCheck(paths, { version: '0.3.0', installed: true, runsFrom: RUNS_FROM, out: () => {} })()).toBe(false);
    expect(existsSync(paths.restartFile)).toBe(false);
  });

  test('a restart file that cannot be read is no damaged one: kept, and read again next round', () => {
    const paths = testPaths(tmp());
    // A folder in its place: reading it fails (EISDIR) the way a held or locked file does, without being damaged.
    mkdirSync(paths.restartFile, { recursive: true });
    expect(readRestartRequest(paths)).toMatchObject({ kind: 'unreadable' });
    let tries = 0;
    const check = restartCheck(paths, { version: '0.3.0', installed: true, runsFrom: RUNS_FROM, out: () => {}, remove: () => void tries++ });
    expect(check()).toBe(false);
    expect(check()).toBe(false);
    expect(tries).toBe(0);
    expect(existsSync(paths.restartFile)).toBe(true);
  });

  test('a restart file that cannot be removed never throws; a damaged one is tried again next round', () => {
    const paths = testPaths(tmp());
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.restartFile, 'not json');
    let tries = 0;
    const remove = () => {
      tries++;
      throw Object.assign(new Error('held'), { code: 'EPERM' });
    };
    const check = restartCheck(paths, { version: '0.3.0', installed: true, runsFrom: RUNS_FROM, out: () => {}, remove });
    expect(check()).toBe(false);
    expect(check()).toBe(false);
    expect(tries).toBe(2);
  });

  test('a request for another version restarts even when its file cannot be removed', () => {
    const paths = testPaths(tmp());
    const out: string[] = [];
    writeRestartRequest(paths, '0.4.0');
    const remove = () => {
      throw Object.assign(new Error('held'), { code: 'EPERM' });
    };
    expect(restartCheck(paths, { version: '0.3.0', installed: true, runsFrom: RUNS_FROM, out: (l) => out.push(l), remove })()).toBe(true);
    expect(out).toEqual(['restarting for fornax 0.4.0']);
  });
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** A paired PC whose installed copy (in app, version 0.3.0) ships an echo pack newer than the installed one. */
async function installedWorker(signal = new AbortController().signal): Promise<{ paths: Paths; ctx: Ctx; out: string[] }> {
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
  const ctx: Ctx = {
    paths, out: (l) => out.push(l), signal, env: {}, script: join(paths.appDir, 'fornax.mjs'), currentVersion: '0.3.0',
    loopOptions: { claimWaitS: 0, checkTimeoutMs: 10_000 },
  };
  return { paths, ctx, out };
}

const failing = async () => {
  throw Object.assign(new Error('busy'), { code: 'EBUSY' });
};

describe('fornax worker --child at start', () => {
  test('an installed copy brings the packs up to its shipped ones; a pack sync that throws does not stop the worker (Review Focus 4)', async () => {
    const { ctx, out } = await installedWorker();
    expect(await workerCommand(ctx, true, { child: true })).toBe(0);
    expect(out).toContain('updated type echo');

    // A sync that throws (a file in use, a disk error): one WARN, the worker still starts and offers echo.
    out.length = 0;
    expect(await workerCommand(ctx, true, { child: true, syncPacks: failing })).toBe(0);
    expect(out).toContain('WARN  the installed types could not be brought up to date (EBUSY); the worker starts with them as they are');
    expect(out).toContain('offering: echo');
  });

  test('a pack sync cut short by a stop (Ctrl+C) prints no WARN', async () => {
    const stop = new AbortController();
    stop.abort();
    const { ctx, out } = await installedWorker(stop.signal);
    expect(await workerCommand(ctx, true, { child: true, syncPacks: failing })).toBe(0);
    expect(out.filter((l) => l.startsWith('WARN'))).toEqual([]);
  });

  test('a restart request for another version ends the child with 75 and releases the worker lock', async () => {
    const { paths, ctx, out } = await installedWorker();
    writeRestartRequest(paths, '0.4.0');
    expect(await workerCommand(ctx, false, { child: true })).toBe(75);
    expect(out).toContain('restarting for fornax 0.4.0');
    const lock = lockWorker(paths);
    expect('release' in lock).toBe(true);
    if ('release' in lock) lock.release();
  });

  test('a copy outside app names the folder it runs from', async () => {
    const stop = new AbortController();
    const { paths, ctx, out } = await installedWorker(stop.signal);
    const outside = join(tmp(), 'elsewhere', 'fornax.mjs');
    writeWorkerDir(dirname(outside), { version: '0.3.0' });
    writeRestartRequest(paths, '0.4.0');
    // It keeps running (the request is not for it): stop it once it has said what to do.
    const say = (l: string) => {
      out.push(l);
      if (l.startsWith('fornax 0.4.0 is installed')) stop.abort();
    };
    expect(await workerCommand({ ...ctx, out: say, script: outside }, false, { child: true })).toBe(0);
    expect(out).toContain(`fornax 0.4.0 is installed in ${paths.appDir}; this worker runs from ${dirname(outside)}: stop it and run fornax worker`);
  });
});
