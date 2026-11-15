import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORNAX_VERSION } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/commands/context.js';
import { compareVersions } from '../src/install/bundle-info.js';
import { lockWorker } from '../src/instance.js';
import { readRestartRequest } from '../src/restart.js';
import { workerZip, writeWorkerDir } from './bundle-fixture.js';
import { testPaths, useTempDir } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A server offering a zip (its JSON always says FORNAX_VERSION), and an installed worker of `installed`. */
async function setup(zip: Buffer, installed = '0.0.1') {
  const workerZipFile = join(tmp(), 'fornax-worker.zip');
  writeFileSync(workerZipFile, zip);
  const s = await startTestServer({ workerZip: workerZipFile });
  servers.push(s);
  const lines: string[] = [];
  const paths = testPaths(tmp());
  writeWorkerDir(paths.appDir, { version: installed });
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.configFile, `server: ${s.url}\n`);
  const ctx: Ctx = { paths, out: (l) => lines.push(l), signal: new AbortController().signal, env: {}, script: join(paths.appDir, 'fornax.mjs'), currentVersion: installed };
  const run = async (...argv: string[]) => {
    lines.length = 0;
    return { code: await runCli(argv, ctx), text: lines.join('\n') };
  };
  return { s, ctx, paths, run, workerZipFile };
}

describe('fornax update', () => {
  test('replaces the app with the server\'s version and says so; no worker runs, so no restart request', async () => {
    const { paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    const r = await run('update');
    expect(r.code).toBe(0);
    expect(r.text).toContain(`updated fornax 0.0.1 → ${FORNAX_VERSION}`);
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe(`${FORNAX_VERSION}\n`);
    expect(readRestartRequest(paths)).toBeUndefined();
  });

  test('the same version: "is current" and nothing else; --force installs it again', async () => {
    const { ctx, run } = await setup(workerZip({ version: FORNAX_VERSION }), FORNAX_VERSION);
    expect((await run('update')).text).toBe(`fornax ${FORNAX_VERSION} is current`);
    ctx.currentVersion = FORNAX_VERSION;
    const forced = await run('update', '--force');
    expect(forced.code).toBe(0);
    expect(forced.text).toContain(`reinstalled fornax ${FORNAX_VERSION}`);
  });

  test('a running worker (lock held): the packs are left to it and a restart request is written', async () => {
    const { paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    const lock = lockWorker(paths);
    if (!('release' in lock)) throw new Error('no lock');
    writeFileSync(lock.file, String(process.ppid)); // another live process holds it
    const r = await run('update');
    expect(r.text).toContain('the worker restarts between jobs (after its running job, if any)');
    expect(readRestartRequest(paths)).toBe(FORNAX_VERSION);
    writeFileSync(lock.file, String(process.pid));
    lock.release();
  });

  test('a zip whose VERSION differs from the announced one changes nothing (Review Focus 2)', async () => {
    const { paths, run } = await setup(workerZip({ version: '0.0.2' }));
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/not the fornax worker .* the server announced/);
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe('0.0.1\n');
    expect(existsSync(`${paths.appDir}.new`)).toBe(false);
  });

  test('bytes that do not match the announced checksum change nothing', async () => {
    const { ctx, paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    ctx.fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (!String(url).endsWith('.zip')) return res;
      const bytes = Buffer.from(await res.arrayBuffer());
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; // same size, other sha256
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    };
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toContain('the download does not match the checksum the server announced; nothing was changed');
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe('0.0.1\n');
  });

  test('not the installed copy: says to install first; no worker.yaml and no --server: says how', async () => {
    const { ctx, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    ctx.script = join(writeWorkerDir(join(tmp(), 'zip')), 'fornax.mjs');
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/^fornax is not installed: run node .* install$/);
    ctx.script = join(ctx.paths.appDir, 'fornax.mjs');
    writeFileSync(ctx.paths.configFile, '');
    const r2 = await run('update');
    expect(r2.code).toBe(1);
  });

  test('an older version on the server is installed too, marked "older"', async () => {
    const { run } = await setup(workerZip({ version: FORNAX_VERSION }), '99.0.0');
    expect((await run('update')).text).toContain(`updated fornax 99.0.0 → ${FORNAX_VERSION} (older; the server offers it)`);
  });
});

test('compareVersions compares dot parts as numbers', () => {
  expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
  expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0);
});
