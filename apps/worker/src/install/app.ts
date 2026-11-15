import { cpSync, existsSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Paths } from '../paths.js';
import { InstallError } from './errors.js';

/** Never part of an installed program or pack: environments a setup made, Python caches, tests. */
export const SKIP_PARTS = new Set(['env', '__pycache__', 'tests']);
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,40}$/;
/** Rename errors that mean "someone holds a file in there for a moment" (Windows: antivirus, indexer, a terminal). */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);

export const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/** The version in <dir>/VERSION (spec 05c 4.1); null when it is missing or not a version. */
export function bundleVersion(dir: string): string | null {
  try {
    const v = readFileSync(join(dir, 'VERSION'), 'utf8').split('\n')[0]!.trim();
    return VERSION_TEXT.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** An unzipped worker bundle: the program, both launchers, VERSION and the shipped types. */
export function isWorkerDir(dir: string): boolean {
  return ['fornax.mjs', 'fornax', 'fornax.cmd', 'VERSION', join('types', 'README.md')].every((f) => existsSync(join(dir, f))) && bundleVersion(dir) !== null;
}

const real = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

/** Whether `script` is <data>/app/fornax.mjs (spec 05c 2), compared the way the OS names files. */
export function isInstalledCopy(script: string, paths: Paths): boolean {
  const a = real(script);
  return a !== null && a === real(join(paths.appDir, 'fornax.mjs'));
}

/** Copy a worker folder without what SKIP_PARTS names, at any depth. */
export function copyWorkerDir(source: string, dest: string): void {
  cpSync(source, dest, { recursive: true, filter: (src) => !relative(source, src).split(sep).some((part) => SKIP_PARTS.has(part)) });
}

export type SwapDeps = { rename?: (from: string, to: string) => void; tries?: number; delayMs?: number };

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const errorCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? 'error';

/** A rename that tries a busy rename `tries` times, `delayMs` apart. */
function retryingRename(deps: SwapDeps): (from: string, to: string) => void {
  const rename = deps.rename ?? renameSync;
  const tries = deps.tries ?? 5;
  const delayMs = deps.delayMs ?? 1000;
  return (from, to) => {
    for (let i = 1; ; i++) {
      try {
        rename(from, to);
        return;
      } catch (e) {
        if (i >= tries || !BUSY.has(errorCode(e))) throw e;
        sleepSync(delayMs);
      }
    }
  };
}

/**
 * An interrupted swap that left only <target>.old: put it back, since it is the only copy. Then <target>.old, if
 * still there, sits next to a whole target and may go.
 */
function restoreLonelyOld(target: string, retrying: (from: string, to: string) => void): void {
  const old = `${target}.old`;
  if (!existsSync(target) && existsSync(old)) retrying(old, target);
}

/**
 * Replace `target` with `stage` (spec 05c 4.3): target → target.old, stage → target, target.old removed. A busy
 * rename is tried `tries` times. When it cannot be done, target is the old one again, whole, and InstallError says why;
 * when even the old one cannot be put back, the error names <target>.old, which is then never deleted.
 */
export function swapDir(stage: string, target: string, deps: SwapDeps = {}): void {
  const retrying = retryingRename(deps);
  const busy = (e: unknown) =>
    new InstallError(
      `${target} could not be replaced (${errorCode(e)}): a program, a terminal or an antivirus scan holds a file in it; close it and run the command again`,
    );
  const old = `${target}.old`;
  try {
    restoreLonelyOld(target, retrying);
    removeDir(old);
  } catch (e) {
    throw busy(e);
  }
  const had = existsSync(target);
  if (had) {
    try {
      retrying(target, old);
    } catch (e) {
      throw busy(e);
    }
  }
  try {
    retrying(stage, target);
  } catch (e) {
    if (had) {
      try {
        retrying(old, target);
      } catch (e2) {
        throw new InstallError(
          `${target} could not be replaced and the old one could not be put back (${errorCode(e2)}): rename ${old} to ${target} by hand`,
        );
      }
    }
    throw busy(e);
  }
  try {
    removeDir(old);
  } catch {
    // A file still held in the old folder: target is whole, so the next install or update removes it.
  }
}

/** What an interrupted install or update left (spec 05c 4.3 step 1). An app.old without app is put back, never deleted. */
export function cleanLeftovers(paths: Paths): void {
  const old = `${paths.appDir}.old`;
  try {
    restoreLonelyOld(paths.appDir, retryingRename({}));
  } catch {
    // Still held: app.old stays (it is the only copy) and the next swapDir tries again.
  }
  for (const d of [`${paths.appDir}.new`, ...(existsSync(paths.appDir) ? [old] : [])]) {
    try {
      removeDir(d);
    } catch {
      // Still held: swapDir removes .old again; .new is replaced by the next extract.
    }
  }
}
