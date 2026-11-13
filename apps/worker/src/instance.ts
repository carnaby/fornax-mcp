import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import type { Paths } from './paths.js';

/** `<data>/worker.lock`: the pid of the one `fornax worker` running on this PC. */
export const LOCK_NAME = 'worker.lock';
/** A lock file without a pid younger than this is still being written by its owner. */
const FRESH_MS = 10_000;
/** Slack for comparing a lock's mtime with the boot time (whole-second uptime, clock adjustments). */
const BOOT_MARGIN_MS = 60_000;
/**
 * A running worker touches its lock this often. The boot rule compares the lock's mtime with the wall clock, which may
 * jump forward after boot (NTP fixing a hardware clock that runs behind): a lock written once at start would then look
 * older than boot and be taken over while its worker runs.
 */
export const LOCK_REFRESH_MS = 60_000;
const RM_RETRIES = { maxRetries: 10, retryDelay: 200 };

export type WorkerLock = { file: string; release: () => void };
export type LockHeld = { file: string; heldBy: number | null };
export type LockOptions = {
  refreshMs?: number;
  /** Test seams: the wall clock and the time since boot. */
  now?: () => number;
  uptimeMs?: () => number;
};

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

/** When the lock file was last written; null when it is gone. */
function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether the pid in a lock file still names the worker that wrote it. A lock written before this system started
 * (a reboot) is stale whatever its pid now names: pids are reused, and a worker started at boot often gets the same
 * one again. A lock holding our own pid is stale too: this process has not written it.
 */
function held(file: string, pid: number | null, now: number, uptimeMs: number): boolean {
  const at = mtime(file);
  if (at === null) return false;
  if (pid === null) return now - at < FRESH_MS;
  if (pid === process.pid) return false;
  const bootedAt = now - uptimeMs;
  if (at < bootedAt - BOOT_MARGIN_MS) return false;
  return alive(pid);
}

/**
 * Take the PC-wide worker lock (two workers would abandon each other's jobs on every claim, and one's start-time sweep would remove the other's job directories).
 * A lock whose process has ended, written before the last boot, or holding our own pid is stale and taken over. Two workers taking over the same stale lock at the very
 * same moment could both succeed; that window is accepted. While held, the lock's mtime is refreshed every `refreshMs`.
 */
export function lockWorker(paths: Paths, opts: LockOptions = {}): WorkerLock | LockHeld {
  const file = join(paths.dataDir, LOCK_NAME);
  const now = opts.now ?? Date.now;
  const uptimeMs = opts.uptimeMs ?? (() => uptime() * 1000);
  mkdirSync(paths.dataDir, { recursive: true });
  for (let tries = 0; ; tries++) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      const refresh = setInterval(() => {
        try {
          // Only our own lock, as release.
          if (readPid(file) !== process.pid) return;
          const t = now() / 1000;
          utimesSync(file, t, t);
        } catch {
          // Gone or busy for a moment; the next round tries again.
        }
      }, opts.refreshMs ?? LOCK_REFRESH_MS);
      refresh.unref();
      return {
        file,
        release: () => {
          clearInterval(refresh);
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
    if (held(file, pid, now(), uptimeMs())) return { file, heldBy: pid };
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
