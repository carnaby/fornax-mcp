import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { JOB_TOOL, testPaths, useTempDir, writeEchoPack } from './helpers.js';

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
    expect(readRestartRequest(paths)).toEqual({ kind: 'none' });
  });

  test('the same version: "is current" and nothing else; --force installs it again', async () => {
    const { run } = await setup(workerZip({ version: FORNAX_VERSION }), FORNAX_VERSION);
    const current = await run('update');
    expect(current.code).toBe(0);
    expect(current.text).toBe(`fornax ${FORNAX_VERSION} is current`);
    const forced = await run('update', '--force');
    expect(forced.code).toBe(0);
    expect(forced.text).toContain(`reinstalled fornax ${FORNAX_VERSION}`);
  });

  test('a running worker (lock held): the packs are left to it and a restart request is written', async () => {
    const typeYaml = readFileSync(join(writeEchoPack(tmp()), 'type.yaml'), 'utf8');
    const { paths, run } = await setup(workerZip({ version: FORNAX_VERSION, packs: { echo: { 'type.yaml': typeYaml, 'scripts/tool.mjs': '// shipped\n' } } }));
    writeEchoPack(paths.typesDir);
    const lock = lockWorker(paths);
    if (!('release' in lock)) throw new Error('no lock');
    writeFileSync(lock.file, String(process.ppid)); // another live process holds it
    try {
      const r = await run('update');
      expect(r.code).toBe(0);
      expect(r.text).toContain('the worker restarts between jobs (after its running job, if any)');
      expect(r.text).not.toContain('updated type echo');
      expect(readFileSync(join(paths.typesDir, 'echo', 'scripts', 'tool.mjs'), 'utf8')).toBe(readFileSync(JOB_TOOL, 'utf8'));
      expect(readRestartRequest(paths)).toEqual({ kind: 'request', version: FORNAX_VERSION });
    } finally {
      writeFileSync(lock.file, String(process.pid));
      lock.release();
    }
  });

  test('--force of the running version with a worker running: reinstalled, and no restart request', async () => {
    const { paths, run } = await setup(workerZip({ version: FORNAX_VERSION }), FORNAX_VERSION);
    const lock = lockWorker(paths);
    if (!('release' in lock)) throw new Error('no lock');
    writeFileSync(lock.file, String(process.ppid));
    try {
      const r = await run('update', '--force');
      expect(r.code).toBe(0);
      expect(r.text).toBe(`reinstalled fornax ${FORNAX_VERSION}`);
      expect(readRestartRequest(paths)).toEqual({ kind: 'none' });
    } finally {
      writeFileSync(lock.file, String(process.pid));
      lock.release();
    }
  });

  test('a zip whose VERSION differs from the announced one changes nothing (Review Focus 2)', async () => {
    const { paths, run } = await setup(workerZip({ version: '0.0.2' }));
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/not the fornax worker .* the server announced/);
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe('0.0.1\n');
    expect(existsSync(`${paths.appDir}.new`)).toBe(false);
  });

  test('a version older than 0.3.0 (no restart support) is refused before any download; nothing changes', async () => {
    const { ctx, paths, run, s } = await setup(workerZip({ version: '0.2.0' }));
    const asked: string[] = [];
    ctx.fetch = async (url, init) => {
      asked.push(String(url));
      if (!String(url).endsWith('.json')) return fetch(url, init);
      return Response.json({ version: '0.2.0', sha256: 'a'.repeat(64), size: 1000 });
    };
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toBe(
      `the server offers fornax 0.2.0, older than 0.3.0: fornax update cannot install it (the worker could not restart into it); install that version by hand from ${s.url}/downloads/fornax-worker.zip`,
    );
    expect(asked.some((u) => u.endsWith('.zip'))).toBe(false);
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe('0.0.1\n');
    expect(existsSync(`${paths.appDir}.new`)).toBe(false);
    expect(readRestartRequest(paths)).toEqual({ kind: 'none' });
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

  test('bytes of another length than announced change nothing', async () => {
    const { ctx, paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    ctx.fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (!String(url).endsWith('.zip')) return res;
      return new Response(Buffer.concat([Buffer.from(await res.arrayBuffer()), Buffer.from([0])]), { status: 200 });
    };
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toContain('the download does not match the checksum the server announced; nothing was changed');
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe('0.0.1\n');
  });

  test('a download that grows past the announced size is stopped while it streams (no content-length)', async () => {
    const { ctx, paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    let sent = 0;
    ctx.fetch = async (url, init) => {
      if (!String(url).endsWith('.zip')) return fetch(url, init);
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          sent += 64 * 1024;
          c.enqueue(new Uint8Array(64 * 1024));
          if (sent > 64 * 1024 * 1024) c.close(); // a bound for the test, far past the cap
        },
      });
      return new Response(body, { status: 200 });
    };
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toBe('the worker bundle is larger than the server announced');
    expect(sent).toBeLessThan(4 * 1024 * 1024);
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe('0.0.1\n');
  });

  test('a connection lost while the zip comes is reported as such', async () => {
    const { ctx, paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    ctx.fetch = async (url, init) => {
      if (!String(url).endsWith('.zip')) return fetch(url, init);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(1024));
          c.error(new TypeError('terminated', { cause: { code: 'ECONNRESET' } }));
        },
      });
      return new Response(body, { status: 200 });
    };
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toBe('cannot reach the server: ECONNRESET');
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe('0.0.1\n');
  });

  test('a swap that cannot put the old app back says so: the swap\'s own message reaches the user', async () => {
    const { ctx, paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    let renames = 0;
    ctx.swapDeps = {
      tries: 1,
      rename: (from, to) => {
        if (++renames > 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        renameSync(from, to); // app -> app.old works, every rename after it is held
      },
    };
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toBe(
      `${paths.appDir} could not be replaced and the old one could not be put back (EBUSY): rename ${paths.appDir}.old to ${paths.appDir} by hand`,
    );
    expect(readFileSync(join(`${paths.appDir}.old`, 'VERSION'), 'utf8')).toBe('0.0.1\n');
    expect(existsSync(`${paths.appDir}.new`)).toBe(false);
  });

  test('not the installed copy: says to install first; no worker.yaml and no --server: says how', async () => {
    const { ctx, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    ctx.script = join(writeWorkerDir(join(tmp(), 'zip')), 'fornax.mjs');
    const r = await run('update');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/^fornax is not installed: run node .* install$/);
    ctx.script = join(ctx.paths.appDir, 'fornax.mjs');
    rmSync(ctx.paths.configFile);
    const r2 = await run('update');
    expect(r2.code).toBe(1);
    expect(r2.text).toContain('; or name the server: fornax update --server <url>');
  });

  test('--server names the server instead of worker.yaml', async () => {
    const { s, paths, run } = await setup(workerZip({ version: FORNAX_VERSION }));
    writeFileSync(paths.configFile, 'server: http://127.0.0.1:9\n');
    const r = await run('update', '--server', s.url);
    expect(r.code).toBe(0);
    expect(r.text).toContain(`updated fornax 0.0.1 → ${FORNAX_VERSION}`);
    expect(readFileSync(join(paths.appDir, 'VERSION'), 'utf8')).toBe(`${FORNAX_VERSION}\n`);
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
