import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { addToPath, mergeUserPath } from '../src/install/path-entry.js';
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
});

describe('addToPath on Windows (seams, no registry)', () => {
  test('adds the folder to the user Path and says to open a new terminal; already there: says so', () => {
    let written: string | null = null;
    const deps = { platform: 'win32' as const, readUserPath: () => 'C:\\a', writeUserPath: (v: string) => { written = v; } };
    expect(addToPath(APP, deps)).toEqual([`added ${APP} to your Path; open a new terminal to use fornax`]);
    expect(written).toBe(`C:\\a;${APP}`);
    expect(addToPath(APP, { ...deps, readUserPath: () => `C:\\a;${APP}` })).toEqual([`fornax is on your Path (${APP})`]);
  });

  test('a failing PowerShell is a WARN with the command to run by hand', () => {
    const lines = addToPath(APP, { platform: 'win32', readUserPath: () => { throw new Error('no powershell'); }, writeUserPath: () => {} });
    expect(lines[0]).toMatch(/^WARN  could not add .* to your Path \(no powershell\); add it by hand:/);
    expect(lines[1]).toContain(`SetEnvironmentVariable('Path'`);
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
});
