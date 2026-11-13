import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Paths } from './paths.js';

/** `<data>/worker.lock`: the pid of the one `fornax worker` running on this PC. */
export const LOCK_NAME = 'worker.lock';
/** A lock file without a pid younger than this is still being written by its owner. */
const FRESH_MS = 10_000;
const RM_RETRIES = { maxRetries: 10, retryDelay: 200 };

export type WorkerLock = { file: string; release: () => void };
export type LockHeld = { file: string; heldBy: number | null };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid in the lock file; null when it holds none, undefined when the file is gone. */
function readPid(file: string): number | null | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function fresh(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs < FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * Take the PC-wide worker lock (two workers would abandon each other's jobs on every claim and share jobs/<id>).
 * A lock whose process has ended is stale and taken over. Two workers taking over the same stale lock at the very
 * same moment could both succeed; that window is accepted.
 */
export function lockWorker(paths: Paths): WorkerLock | LockHeld {
  const file = join(paths.dataDir, LOCK_NAME);
  mkdirSync(paths.dataDir, { recursive: true });
  for (let tries = 0; ; tries++) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return {
        file,
        release: () => {
          // Only our own lock: a worker that took over a lock it thought stale must keep it.
          if (readPid(file) !== process.pid) return;
          try {
            unlinkSync(file);
          } catch {
            // Gone already.
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // A few rounds at most: another worker is starting at the same moment.
    if (tries >= 3) return { file, heldBy: readPid(file) ?? null };
    const pid = readPid(file);
    if (pid === undefined) continue;
    if (pid === null ? fresh(file) : alive(pid)) return { file, heldBy: pid };
    try {
      unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

/**
 * Remove what earlier runs left in `<data>/jobs` (a crash, a hard quit, a file a leftover process held).
 * Best effort: failures are counted, with the first error code, never thrown.
 */
export async function sweepJobs(
  paths: Paths,
  remove: (dir: string) => Promise<void> = (dir) => rm(dir, { recursive: true, force: true, ...RM_RETRIES }),
): Promise<{ failed: number; code: string | null }> {
  let entries: string[];
  try {
    entries = await readdir(paths.jobsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { failed: 0, code: null };
    return { failed: 1, code: (e as NodeJS.ErrnoException).code ?? 'error' };
  }
  let failed = 0;
  let code: string | null = null;
  for (const entry of entries) {
    try {
      await remove(join(paths.jobsDir, entry));
    } catch (e) {
      failed++;
      code ??= (e as NodeJS.ErrnoException).code ?? 'error';
    }
  }
  return { failed, code };
}
