import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORNAX_VERSION } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/commands/context.js';
import type { TrayDeps, TrayKind } from '../src/commands/tray.js';
import { testPaths, useTempDir } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/**
 * A server with a fake MSI and deb, a paired PC, and stand-ins for the system: `kind` is what this PC takes, `code`
 * what the installer returns, `alive` whether the waited-for process still runs.
 */
async function setup(opts: { kind?: TrayKind | null; code?: number | null; alive?: () => boolean; paired?: boolean; msi?: Buffer | null } = {}) {
  const dir = tmp();
  const trayMsi = join(dir, 'fornax-tray.msi');
  const trayDeb = join(dir, 'fornax-tray.deb');
  const msi = opts.msi === undefined ? Buffer.from('fake msi') : opts.msi;
  if (msi) writeFileSync(trayMsi, msi);
  writeFileSync(trayDeb, Buffer.from('fake deb'));
  const s = await startTestServer({ trayMsi, trayDeb });
  servers.push(s);
  const paths = testPaths(tmp());
  if (opts.paired !== false) {
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, `server: ${s.url}\n`);
  }
  const installs: { kind: TrayKind; file: string; bytes: string }[] = [];
  const launched: string[] = [];
  const tray: Partial<TrayDeps> = {
    kind: () => (opts.kind === undefined ? 'msi' : opts.kind),
    install: async (kind, file) => {
      installs.push({ kind, file, bytes: readFileSync(file, 'utf8') });
      return opts.code === undefined ? 0 : opts.code;
    },
    alive: opts.alive ?? (() => false),
    launch: (path) => launched.push(path),
    waitMs: 300,
  };
  const lines: string[] = [];
  const ctx: Ctx = { paths, out: (l) => lines.push(l), signal: new AbortController().signal, env: {}, tray };
  const run = async (...argv: string[]) => ({ code: await runCli(argv, ctx), text: lines.join('\n') });
  const log = () => readFileSync(join(paths.dataDir, 'tray-update.log'), 'utf8');
  return { s, ctx, paths, run, installs, launched, log, trayMsi };
}

describe('fornax tray install (spec 06d 3)', () => {
  test('downloads the installer for this system, checks it, runs it and removes it', async () => {
    const w = await setup();
    const r = await w.run('tray', 'install');
    expect(r.code).toBe(0);
    expect(w.installs).toEqual([{ kind: 'msi', file: join(w.paths.dataDir, 'downloads', `fornax-tray-${FORNAX_VERSION}.msi`), bytes: 'fake msi' }]);
    expect(existsSync(w.installs[0]!.file)).toBe(false);
    expect(r.text).toContain(`fornax tray ${FORNAX_VERSION} installed`);
    expect(w.launched).toEqual([]);
    expect(existsSync(join(w.paths.dataDir, 'tray-update.log'))).toBe(false);
  });

  test('Linux with dpkg takes the deb', async () => {
    const w = await setup({ kind: 'deb' });
    expect((await w.run('tray', 'install')).code).toBe(0);
    expect(w.installs.map((i) => [i.kind, i.bytes])).toEqual([['deb', 'fake deb']]);
  });

  test('no installer for this system, or none on the server: says so, installs nothing', async () => {
    const none = await setup({ kind: null });
    const r = await none.run('tray', 'install');
    expect(r.code).toBe(1);
    expect(r.text).toBe('the server has no tray installer for this system; on Linux without dpkg use the AppImage from the GitHub release');
    const noMsi = await setup({ msi: null });
    expect((await noMsi.run('tray', 'install')).code).toBe(1);
    expect(noMsi.installs).toEqual([]);
  });

  test('an unpaired PC is told to pair first', async () => {
    const w = await setup({ paired: false });
    const r = await w.run('tray', 'install');
    expect(r.code).toBe(1);
    expect(r.text).toBe('pair this PC first (fornax worker pair)');
  });

  test('a download that does not match the checksum installs nothing; the tray is started again', async () => {
    const w = await setup();
    // The installer arrives altered (same size, other bytes): the server's JSON still has the real checksum.
    w.ctx.fetch = async (input, init) => (String(input).endsWith('/fornax-tray.msi') ? new Response('FAKE MSI') : fetch(input, init));
    const r = await w.run('tray', 'install', '--relaunch', '/opt/tray');
    expect(r.code).toBe(1);
    expect(r.text).toContain('the download does not match the checksum the server announced; nothing was installed');
    expect(w.installs).toEqual([]);
    expect(existsSync(join(w.paths.dataDir, 'downloads', `fornax-tray-${FORNAX_VERSION}.msi`))).toBe(false);
    expect(w.launched).toEqual(['/opt/tray']);
  });

  test('--wait-pid waits for the old tray to exit, then installs; the log has every line', async () => {
    let checks = 0;
    const w = await setup({ alive: () => ++checks < 3 });
    const r = await w.run('tray', 'install', '--wait-pid', '4242', '--relaunch', '/opt/tray');
    expect(r.code).toBe(0);
    expect(checks).toBe(3);
    expect(w.installs).toHaveLength(1);
    expect(w.launched).toEqual(['/opt/tray']);
    expect(w.log().trim().split('\n').at(-2)).toBe(`fornax tray ${FORNAX_VERSION} installed`);
  });

  test('an old tray that does not exit: nothing installed, nothing started', async () => {
    const w = await setup({ alive: () => true });
    const r = await w.run('tray', 'install', '--wait-pid', '4242', '--relaunch', '/opt/tray');
    expect(r.code).toBe(1);
    expect(r.text).toContain('the tray did not exit; nothing was installed');
    expect(w.installs).toEqual([]);
    expect(w.launched).toEqual([]);
  });

  test('a cancelled installation still starts the tray again; installer codes are said', async () => {
    const cases: [TrayKind, number | null, number, string][] = [
      ['msi', 3010, 0, `fornax tray ${FORNAX_VERSION} installed`],
      ['msi', 1602, 1, 'the installation was cancelled'],
      ['msi', 1603, 1, 'msiexec failed with code 1603; see '],
      ['deb', 126, 1, 'the installation was cancelled'],
      ['deb', 100, 1, 'apt-get failed with code 100'],
      ['msi', null, 1, 'the installer could not be started'],
    ];
    for (const [kind, installerCode, exit, line] of cases) {
      const w = await setup({ kind, code: installerCode });
      const r = await w.run('tray', 'install', '--relaunch', '/opt/tray');
      expect([r.code, r.text.includes(line)], `${kind} ${installerCode}`).toEqual([exit, true]);
      expect(w.launched).toEqual(['/opt/tray']);
    }
  });

  test('a bad --wait-pid is a usage error', async () => {
    const w = await setup();
    expect((await w.run('tray', 'install', '--wait-pid', 'abc')).code).toBe(2);
  });
});
