import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { InstallError } from '../src/install/errors.js';
import { bundleVersion, cleanLeftovers, copyWorkerDir, isInstalledCopy, isWorkerDir, swapDir } from '../src/install/app.js';
import { writeWorkerDir } from './bundle-fixture.js';
import { testPaths, useTempDir } from './helpers.js';

const tmp = useTempDir();

describe('the app folder', () => {
  test('a worker folder has the launchers, VERSION and types/; its version is read from VERSION', () => {
    const dir = writeWorkerDir(join(tmp(), 'fornax-worker'), { version: '0.3.0' });
    expect(isWorkerDir(dir)).toBe(true);
    expect(bundleVersion(dir)).toBe('0.3.0');
    writeFileSync(join(dir, 'VERSION'), 'not a version!\n');
    expect(isWorkerDir(dir)).toBe(false);
    expect(isWorkerDir(tmp())).toBe(false);
  });

  test('the installed copy is <data>/app/fornax.mjs, nothing else', () => {
    const paths = testPaths(tmp());
    writeWorkerDir(paths.appDir);
    const elsewhere = writeWorkerDir(join(tmp(), 'zip'));
    expect(isInstalledCopy(join(paths.appDir, 'fornax.mjs'), paths)).toBe(true);
    expect(isInstalledCopy(join(elsewhere, 'fornax.mjs'), paths)).toBe(false);
    expect(isInstalledCopy(join(tmp(), 'missing.mjs'), paths)).toBe(false);
  });

  test('copyWorkerDir leaves out env, __pycache__ and tests', () => {
    const src = writeWorkerDir(join(tmp(), 'src'), { packs: { t: { 'type.yaml': 'x', 'env/lib.txt': 'x', 'tests/a.py': 'x', 'scripts/__pycache__/a.pyc': 'x', 'scripts/run.py': 'x' } } });
    const dest = join(tmp(), 'dest');
    copyWorkerDir(src, dest);
    expect(existsSync(join(dest, 'types', 't', 'scripts', 'run.py'))).toBe(true);
    for (const gone of ['env', 'tests', join('scripts', '__pycache__')]) expect(existsSync(join(dest, 'types', 't', gone))).toBe(false);
  });

  test('swapDir replaces the target, creates it when missing, and removes .old', () => {
    const root = tmp();
    const target = join(root, 'app');
    writeWorkerDir(`${target}.new`, { version: '1.0.0' });
    swapDir(`${target}.new`, target);
    expect(bundleVersion(target)).toBe('1.0.0');
    writeWorkerDir(`${target}.new`, { version: '2.0.0' });
    swapDir(`${target}.new`, target);
    expect(bundleVersion(target)).toBe('2.0.0');
    expect(existsSync(`${target}.new`) || existsSync(`${target}.old`)).toBe(false);
  });

  test('a rename that fails a few times is retried', () => {
    const target = join(tmp(), 'app');
    writeWorkerDir(target, { version: '1.0.0' });
    writeWorkerDir(`${target}.new`, { version: '2.0.0' });
    let failures = 2;
    const rename = (a: string, b: string) => {
      if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      renameSync(a, b);
    };
    swapDir(`${target}.new`, target, { rename, delayMs: 1 });
    expect(bundleVersion(target)).toBe('2.0.0');
  });

  test('a rename that keeps failing leaves the old app whole (Review Focus 1)', () => {
    const target = join(tmp(), 'app');
    writeWorkerDir(target, { version: '1.0.0' });
    writeWorkerDir(`${target}.new`, { version: '2.0.0' });
    // The first rename (app → app.old) works, the second (app.new → app) never does: the old one must come back.
    let calls = 0;
    const rename = (a: string, b: string) => {
      if (++calls >= 2 && a.endsWith('.new')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      renameSync(a, b);
    };
    expect(() => swapDir(`${target}.new`, target, { rename, delayMs: 1 })).toThrow(InstallError);
    expect(bundleVersion(target)).toBe('1.0.0');
    expect(readFileSync(join(target, 'fornax.mjs'), 'utf8')).toContain('1.0.0');
  });

  test('cleanLeftovers removes app.new and app.old of an interrupted run', () => {
    const paths = testPaths(tmp());
    for (const d of [`${paths.appDir}.new`, `${paths.appDir}.old`]) mkdirSync(d, { recursive: true });
    cleanLeftovers(paths);
    expect(existsSync(`${paths.appDir}.new`) || existsSync(`${paths.appDir}.old`)).toBe(false);
  });
});
