import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { addToPath, mergeUserPath, psOut, readUserPathRaw } from '../src/install/path-entry.js';
import { useTempDir } from './helpers.js';

const tmp = useTempDir();
const APP = 'C:\\Users\\u\\AppData\\Local\\fornax\\app';

describe('mergeUserPath', () => {
  test('appends once, ignoring case and a trailing backslash', () => {
    expect(mergeUserPath('C:\\a;C:\\b', APP)).toBe(`C:\\a;C:\\b;${APP}`);
    expect(mergeUserPath('C:\\a;', APP)).toBe(`C:\\a;${APP}`);
    expect(mergeUserPath(null, APP)).toBe(APP);
    expect(mergeUserPath(`C:\\a;${APP.toUpperCase()}\\`, APP)).toBeNull();
  });

  test('compares %VAR% entries expanded (names without case) and keeps them unexpanded in the result', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', UserProfile: 'C:\\Users\\u' };
    expect(mergeUserPath('C:\\a;%LOCALAPPDATA%\\fornax\\app', APP, env)).toBeNull();
    expect(mergeUserPath('%localappdata%\\Fornax\\App\\', APP, env)).toBeNull();
    expect(mergeUserPath('%USERPROFILE%\\bin;%NOPE%\\x', APP, env)).toBe(`%USERPROFILE%\\bin;%NOPE%\\x;${APP}`);
  });
});

describe('addToPath on Windows (seams, no registry)', () => {
  test('adds the folder to the user Path, keeping its registry kind, and says to open a new terminal; already there: says so', () => {
    const written: [string, string][] = [];
    const deps = {
      platform: 'win32' as const,
      readUserPath: () => ({ value: '%USERPROFILE%\\bin', kind: 'ExpandString' as const }),
      writeUserPath: (v: string, k: string) => { written.push([v, k]); },
    };
    expect(addToPath(APP, deps)).toEqual([`added ${APP} to your Path; open a new terminal to use fornax`]);
    expect(addToPath(APP, { ...deps, readUserPath: () => ({ value: 'C:\\a', kind: 'String' as const }) })).toHaveLength(1);
    expect(addToPath(APP, { ...deps, readUserPath: () => ({ value: null, kind: 'ExpandString' as const }) })).toHaveLength(1);
    expect(written).toEqual([[`%USERPROFILE%\\bin;${APP}`, 'ExpandString'], [`C:\\a;${APP}`, 'String'], [APP, 'ExpandString']]);
    expect(addToPath(APP, { ...deps, readUserPath: () => ({ value: `C:\\a;${APP}`, kind: 'String' as const }) })).toEqual([`fornax is on your Path (${APP})`]);
    expect(written).toHaveLength(3);
  });

  test('a failing PowerShell is a WARN with the command to run by hand (a quote in the folder doubled)', () => {
    const lines = addToPath(APP, { platform: 'win32', readUserPath: () => { throw new Error('no powershell'); }, writeUserPath: () => {} });
    expect(lines[0]).toMatch(/^WARN  could not add .* to your Path \(no powershell\); add it by hand:/);
    expect(lines[1]).toContain(`SetEnvironmentVariable('Path'`);
    const quoted = addToPath("C:\\Users\\o'b\\fornax\\app", { platform: 'win32', readUserPath: () => { throw new Error('x'); } });
    expect(quoted[1]).toContain("';C:\\Users\\o''b\\fornax\\app', 'User')");
  });
});

describe('PowerShell on Windows (real powershell.exe, reads only)', () => {
  test.runIf(process.platform === 'win32')('output is read as UTF-8 (Windows PowerShell writes the OEM code page otherwise)', () => {
    expect(psOut('[string][char]0x017E + [char]0x00E1').trimEnd()).toBe('\u017E\u00E1');
  });

  test.runIf(process.platform === 'win32')('the user Path is read raw from the registry with its kind (reads only, never written)', () => {
    const { value, kind } = readUserPathRaw();
    expect(['String', 'ExpandString']).toContain(kind);
    if (value !== null) expect(value).not.toMatch(/[\r\n]/);
  });
});

describe.skipIf(process.platform === 'win32')('addToPath on Linux (symlinks need no privilege here)', () => {
  test('links ~/.local/bin/fornax to app/fornax and says how to get ~/.local/bin on PATH', () => {
    const home = tmp();
    const app = join(home, '.local', 'share', 'fornax', 'app');
    mkdirSync(app, { recursive: true });
    const lines = addToPath(app, { platform: 'linux', home, env: { PATH: '/usr/bin' } });
    const link = join(home, '.local', 'bin', 'fornax');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(app, 'fornax'));
    expect(lines.some((l) => l.includes('export PATH="$HOME/.local/bin:$PATH"'))).toBe(true);
    // On PATH already, link already there: one quiet line.
    expect(addToPath(app, { platform: 'linux', home, env: { PATH: `${join(home, '.local', 'bin')}:/usr/bin` } })).toEqual([`fornax is on your PATH (${link})`]);
  });

  test('a link into an older app is replaced; a foreign file is left alone with a WARN', () => {
    const home = tmp();
    const app = join(home, 'app');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(app, 'old', 'fornax'), join(bin, 'fornax'));
    addToPath(app, { platform: 'linux', home, env: { PATH: bin } });
    expect(readlinkSync(join(bin, 'fornax'))).toBe(join(app, 'fornax'));
    const other = tmp();
    mkdirSync(join(other, '.local', 'bin'), { recursive: true });
    writeFileSync(join(other, '.local', 'bin', 'fornax'), '#!/bin/sh\n');
    const lines = addToPath(app, { platform: 'linux', home: other, env: { PATH: join(other, '.local', 'bin') } });
    expect(lines[0]).toMatch(/^WARN  .*fornax exists and is not a link to/);
  });

  test('a link outside the data directory (also a sibling folder sharing its name as a prefix) is left alone with a WARN', () => {
    const home = tmp();
    const app = join(home, 'data', 'app');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    for (const elsewhere of ['/usr/local/bin/other', join(home, 'data-other', 'fornax')]) {
      rmSync(join(bin, 'fornax'), { force: true });
      symlinkSync(elsewhere, join(bin, 'fornax'));
      const lines = addToPath(app, { platform: 'linux', home, env: { PATH: bin } });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^WARN  .*fornax exists and is not a link to/);
      expect(readlinkSync(join(bin, 'fornax'))).toBe(elsewhere);
    }
  });

  test('empty PATH entries are not taken for the current directory (run from inside ~/.local/bin)', () => {
    const home = tmp();
    const app = join(home, 'app');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const cwd = process.cwd();
    process.chdir(bin);
    try {
      const lines = addToPath(app, { platform: 'linux', home, env: { PATH: '::/usr/bin:' } });
      expect(lines.some((l) => l.includes('export PATH="$HOME/.local/bin:$PATH"'))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});
