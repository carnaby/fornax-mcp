import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { lockWorker, sweepJobs } from '../src/instance.js';
import { testPaths, useTempDir } from './helpers.js';

const tmp = useTempDir();

/** The pid of a process that has already ended. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  return r.pid!;
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

/** The pid of a process that keeps running until the test ends: another worker. */
function livePid(): number {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => 0, 1000)'], { stdio: 'ignore', windowsHide: true });
  children.push(c);
  return c.pid!;
}

/** A lock file holding `pid`, written `ageMs` ago. */
function writeLock(dataDir: string, pid: number, ageMs = 0): string {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'worker.lock');
  writeFileSync(file, String(pid));
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(file, at, at);
  return file;
}

describe('one worker per PC', () => {
  test('a fresh lock held by another live process is refused; after that process ends the lock is taken over', () => {
    const paths = testPaths(tmp());
    const other = livePid();
    const file = writeLock(paths.dataDir, other);
    expect(lockWorker(paths)).toEqual({ heldBy: other, file });
    writeLock(paths.dataDir, deadPid());
    const lock = lockWorker(paths);
    expect('release' in lock).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    if ('release' in lock) lock.release();
    expect(existsSync(file)).toBe(false);
  });

  test('a lock holding this very pid is stale (a reboot handed the old pid to this process) and is taken over', () => {
    const paths = testPaths(tmp());
    const file = writeLock(paths.dataDir, process.pid);
    const lock = lockWorker(paths);
    expect('release' in lock).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    if ('release' in lock) lock.release();
  });

  test('a lock written before the system started is stale even when its pid now belongs to a live process', () => {
    const paths = testPaths(tmp());
    // An hour before boot: the pid was reused after a reboot.
    const file = writeLock(paths.dataDir, livePid(), uptime() * 1000 + 3_600_000);
    const lock = lockWorker(paths);
    expect('release' in lock).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    if ('release' in lock) lock.release();
  });

  test('a lock left by a process that has ended is taken over', () => {
    const paths = testPaths(tmp());
    mkdirSync(paths.dataDir, { recursive: true });
    const file = join(paths.dataDir, 'worker.lock');
    writeFileSync(file, String(deadPid()));
    const lock = lockWorker(paths);
    expect('release' in lock).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    if ('release' in lock) lock.release();
  });

  test('release never removes a lock another process took over meanwhile', () => {
    const paths = testPaths(tmp());
    const lock = lockWorker(paths);
    const file = join(paths.dataDir, 'worker.lock');
    writeFileSync(file, '999999999');
    if ('release' in lock) lock.release();
    expect(readFileSync(file, 'utf8')).toBe('999999999');
  });
});

describe('sweepJobs', () => {
  test('removes what earlier runs left in the jobs directory', async () => {
    const paths = testPaths(tmp());
    mkdirSync(join(paths.jobsDir, 'OLDJOB1', 'work'), { recursive: true });
    writeFileSync(join(paths.jobsDir, 'OLDJOB1', 'work', 'x.txt'), 'x');
    writeFileSync(join(paths.jobsDir, 'stray.txt'), 'x');
    expect(await sweepJobs(paths)).toEqual({ failed: 0, code: null });
    expect(existsSync(join(paths.jobsDir, 'OLDJOB1'))).toBe(false);
    expect(existsSync(join(paths.jobsDir, 'stray.txt'))).toBe(false);
  });

  test('a missing jobs directory is nothing to do; a removal that fails is counted, not thrown', async () => {
    const paths = testPaths(tmp());
    expect(await sweepJobs(paths)).toEqual({ failed: 0, code: null });
    mkdirSync(join(paths.jobsDir, 'A'), { recursive: true });
    const r = await sweepJobs(paths, async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    expect(r).toEqual({ failed: 1, code: 'EBUSY' });
  });
});
