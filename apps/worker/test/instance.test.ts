import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { lockWorker, sweepJobs } from '../src/instance.js';
import { testPaths, useTempDir } from './helpers.js';

const tmp = useTempDir();

/** The pid of a process that has already ended. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  return r.pid!;
}

describe('one worker per PC', () => {
  test('a second lock attempt is refused while the first holds it; after release it succeeds', () => {
    const paths = testPaths(tmp());
    const first = lockWorker(paths);
    expect('release' in first).toBe(true);
    const second = lockWorker(paths);
    expect(second).toEqual({ heldBy: process.pid, file: join(paths.dataDir, 'worker.lock') });
    if ('release' in first) first.release();
    expect(existsSync(join(paths.dataDir, 'worker.lock'))).toBe(false);
    const third = lockWorker(paths);
    expect('release' in third).toBe(true);
    if ('release' in third) third.release();
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
