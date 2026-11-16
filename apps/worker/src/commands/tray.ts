import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, NetworkError } from '../api.js';
import { ConfigError, readWorkerConfig } from '../config.js';
import { downloadBytes } from '../install/download.js';
import { InstallError } from '../install/errors.js';
import { fetchTrayInfo } from '../install/tray-info.js';
import type { Ctx } from './context.js';

export type TrayKind = 'msi' | 'deb';

/** What `fornax tray install` needs of the system (spec 06d 3); tests replace it. */
export type TrayDeps = {
  /** The installer this system takes, or null. */
  kind: () => TrayKind | null;
  /** Runs the installer and resolves with its exit code; null when it could not start. */
  install: (kind: TrayKind, file: string, log: string) => Promise<number | null>;
  /** Whether the process still runs. */
  alive: (pid: number) => boolean;
  /** Starts the tray, detached: a non-detached child of Node dies with it on Windows. */
  launch: (path: string) => void;
  /** How long --wait-pid waits. */
  waitMs: number;
};

/** The helper's lines for the next tray (spec 06d 3, 4.3), in <data>. */
export const TRAY_UPDATE_LOG = 'tray-update.log';
const NO_INSTALLER = 'the server has no tray installer for this system; on Linux without dpkg use the AppImage from the GitHub release';

const hasDpkg = () => spawnSync('dpkg', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;

export const systemTray: TrayDeps = {
  kind: () => (process.platform === 'win32' ? 'msi' : process.platform === 'linux' && hasDpkg() ? 'deb' : null),
  install: (kind, file, log) =>
    new Promise((resolve) => {
      // In a terminal sudo asks for the password there; started by the tray (no terminal) pkexec asks in a window.
      const terminal = process.stdin.isTTY === true;
      const [program, args]: [string, string[]] =
        kind === 'msi' ? ['msiexec', ['/i', file, '/passive', '/norestart', '/l*v', log]] : [terminal ? 'sudo' : 'pkexec', ['apt-get', 'install', '-y', file]];
      const child = spawn(program, args, { stdio: kind === 'deb' && terminal ? 'inherit' : 'ignore', windowsHide: true });
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code));
    }),
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  launch: (path) => {
    spawn(path, [], { detached: true, stdio: 'ignore' }).unref();
  },
  waitMs: 60_000,
};

/** The sentence for an installer's exit code; ok for success. */
function outcome(kind: TrayKind, code: number | null, log: string): { ok: boolean; line: string } {
  if (code === null) return { ok: false, line: 'the installer could not be started' };
  if (kind === 'msi') {
    if (code === 0 || code === 3010) return { ok: true, line: '' };
    if (code === 1602) return { ok: false, line: 'the installation was cancelled' };
    return { ok: false, line: `msiexec failed with code ${code}; see ${log}` };
  }
  if (code === 0) return { ok: true, line: '' };
  if (code === 126 || code === 127) return { ok: false, line: 'the installation was cancelled' };
  return { ok: false, line: `apt-get failed with code ${code}` };
}

/**
 * `fornax tray install [--wait-pid <pid>] [--relaunch <path>]` (spec 06d 3): the server's tray installer for this
 * system, checked and run. Called by the tray it waits for the old tray to exit and starts the tray again afterwards,
 * whatever happened (but not when the old tray did not exit), and writes its lines to <data>/tray-update.log too.
 */
export async function trayInstallCommand(ctx: Ctx, opts: { waitPid?: number; relaunch?: string }): Promise<number> {
  const deps: TrayDeps = { ...systemTray, ...ctx.tray };
  const helper = opts.waitPid !== undefined || opts.relaunch !== undefined;
  const logFile = join(ctx.paths.dataDir, TRAY_UPDATE_LOG);
  if (helper) {
    try {
      mkdirSync(ctx.paths.dataDir, { recursive: true });
      writeFileSync(logFile, '');
    } catch {
      // Without the log the next tray only misses the reason.
    }
  }
  const say = (line: string) => {
    ctx.out(line);
    if (helper) {
      try {
        appendFileSync(logFile, `${line}\n`);
      } catch {
        // As above.
      }
    }
  };
  let relaunch = opts.relaunch;
  let gone = opts.waitPid === undefined;
  /** Whether the old tray has exited (at most waitMs); a second call after it has answers at once. */
  const oldTrayGone = async (): Promise<boolean> => {
    if (gone || opts.waitPid === undefined) return true;
    const deadline = Date.now() + deps.waitMs;
    while (deps.alive(opts.waitPid)) {
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(200, deps.waitMs));
    }
    gone = true;
    return true;
  };
  try {
    return await install(ctx, deps, say, oldTrayGone, () => {
      relaunch = undefined;
    });
  } catch (e) {
    const known = e instanceof InstallError || e instanceof NetworkError || e instanceof ApiError || e instanceof ConfigError;
    say(known ? (e as Error).message : `unexpected error: ${e instanceof Error ? e.constructor.name : typeof e}`);
    return 1;
  } finally {
    // Also after an early failure the old tray must be gone first: a second tray would only open the old one's window
    // and end, and then the old one ends too.
    if (relaunch !== undefined) {
      if (await oldTrayGone()) {
        // Not in the log: the next tray shows the log's last line, which must stay the reason.
        ctx.out('starting the tray again');
        try {
          deps.launch(relaunch);
        } catch {
          ctx.out('the tray could not be started again: start it from the Start menu');
        }
      } else {
        say('the tray did not exit; it is not started again');
      }
    }
  }
}

async function install(ctx: Ctx, deps: TrayDeps, say: (line: string) => void, oldTrayGone: () => Promise<boolean>, noRelaunch: () => void): Promise<number> {
  let server: string;
  try {
    server = readWorkerConfig(ctx.paths).server;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    say('pair this PC first (fornax worker pair)');
    return 1;
  }
  const base = server.replace(/\/+$/, '');
  const kind = deps.kind();
  if (kind === null) {
    say(NO_INSTALLER);
    return 1;
  }
  const info = await fetchTrayInfo(base, ctx.signal, ctx.fetch);
  const entry = info[kind];
  if (entry === null) {
    say(NO_INSTALLER);
    return 1;
  }
  const bytes = await downloadBytes(ctx, `${base}/downloads/fornax-tray.${kind}`, entry.size, 'tray installer');
  if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new InstallError('the download does not match the checksum the server announced; nothing was installed');
  }
  const dir = join(ctx.paths.dataDir, 'downloads');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `fornax-tray-${info.version}.${kind}`);
  writeFileSync(file, bytes);
  if (!(await oldTrayGone())) {
    noRelaunch();
    rmSync(file, { force: true });
    say('the tray did not exit; nothing was installed');
    return 1;
  }
  say(`installing fornax tray ${info.version}`);
  const log = join(dir, 'fornax-tray-install.log');
  const result = outcome(kind, await deps.install(kind, file, log), log);
  if (!result.ok) {
    say(result.line);
    return 1;
  }
  rmSync(file, { force: true });
  say(`fornax tray ${info.version} installed`);
  return 0;
}
