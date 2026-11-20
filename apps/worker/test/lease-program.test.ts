import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LeaseFiles, sweepLeases } from '../src/lease/files.js';
import { defaultLabel, exitCodeOf, labelProblem, leaseEnv, programProblem, startProgram } from '../src/lease/program.js';
import { killRunning } from '../src/process.js';
import { isAlive, LEASE_PROGRAM, processGroupOf, readJson, readPids, useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
const env = () => leaseEnv(process.env, 'JOB1');

describe('what fornax lease checks before asking for a lease', () => {
  test('the label: the program name without path and extension, cut to what the lease type takes', () => {
    expect(defaultLabel('C:\\Program Files\\Blender Foundation\\blender.exe')).toBe('blender');
    expect(defaultLabel('/opt/blender/blender')).toBe('blender');
    expect(defaultLabel('./render-shot.mjs')).toBe('render-shot');
    expect(defaultLabel('Blender 4.2 Launcher.exe')).toBe('Blender 4.2 Launcher');
    expect(defaultLabel('\u0431\u043b\u0435\u043d\u0434\u0435\u0440.exe')).toBeNull();
    expect(defaultLabel('--x.exe')).toBe('x');
    expect(defaultLabel(`${'a'.repeat(100)}.exe`)).toBe('a'.repeat(80));
    expect(labelProblem('shot 12/40: beauty')).toBeNull();
    for (const bad of ['-x', 'a;b', '\u00e9', 'x'.repeat(81)]) expect(labelProblem(bad), bad).not.toBeNull();
    expect(labelProblem('a;b')).toContain('ASCII letters and digits');
  });

  test('a batch file is refused on Windows; a missing program everywhere; a real one passes', () => {
    expect(programProblem('build.cmd', {}, 'win32')).toMatch(/batch file/);
    expect(programProblem('C:\\tools\\run.BAT', {}, 'win32')).toMatch(/batch file/);
    expect(programProblem(join(tmp(), 'missing-program'), {})).toMatch(/was not found/);
    expect(programProblem(process.execPath, {})).toBeNull();
  });

  test('the program gets FORNAX_LEASE and never the client token', () => {
    expect(leaseEnv({ PATH: '/bin', FORNAX_CLIENT_TOKEN: 'secret', fornax_client_token: 'x', FORNAX_LEASE: 'OLD', FORNAX_DATA_DIR: '/d' }, 'JOB1')).toEqual({
      PATH: '/bin', FORNAX_DATA_DIR: '/d', FORNAX_LEASE: 'JOB1',
    });
  });

  test('exit codes: the program code, 128 + the signal number, else 1', () => {
    expect(exitCodeOf({ code: 7, signal: null, spawnError: null })).toBe(7);
    expect(exitCodeOf({ code: null, signal: 'SIGTERM', spawnError: null })).toBe(143);
    expect(exitCodeOf({ code: null, signal: 'SIGKILL', spawnError: null })).toBe(137);
    expect(exitCodeOf({ code: null, signal: null, spawnError: null })).toBe(1);
  });
});

describe('the program', () => {
  test('runs with the environment it is given; its exit code comes back', async () => {
    const report = join(tmp(), 'report.json');
    const p = startProgram(process.execPath, [LEASE_PROGRAM, '--report', report, '--exit', '7'], { cwd: tmp(), env: env() });
    expect(await p.exited).toEqual({ code: 7, signal: null, spawnError: null });
    expect(readJson(report)).toMatchObject({ lease: 'JOB1' });
  });

  test('kill ends the whole tree', async () => {
    const pids = join(tmp(), 'pids.json');
    const p = startProgram(process.execPath, [LEASE_PROGRAM, '--tree', pids, '--forever'], { cwd: tmp(), env: env(), killGraceMs: 500 });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the tree');
    await p.kill();
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
  });

  test('Linux: what the program left in its group ends with it (it would hold the card); Windows cannot find it', async () => {
    const pids = join(tmp(), 'pids.json');
    const p = startProgram(process.execPath, [LEASE_PROGRAM, '--tree', pids, '--sleep', '300'], { cwd: tmp(), env: env(), killGraceMs: 500 });
    await p.exited;
    const { child } = readPids(pids)!;
    if (process.platform === 'win32') {
      expect(isAlive(child)).toBe(true);
      process.kill(child);
    } else {
      await waitFor(() => !isAlive(child), 5000, 'the leftover to end');
    }
  });

  test('ownGroup false (a nested lease): Linux: it stays in the process group of the caller, which ends it; kill still ends it', async () => {
    const reports = [join(tmp(), 'own.json'), join(tmp(), 'caller.json')];
    const own = startProgram(process.execPath, [LEASE_PROGRAM, '--report', reports[0]!, '--forever'], { cwd: tmp(), env: env(), killGraceMs: 500 });
    const inCaller = startProgram(process.execPath, [LEASE_PROGRAM, '--report', reports[1]!, '--forever'], {
      cwd: tmp(), env: env(), killGraceMs: 500, ownGroup: false,
    });
    const [a, b] = await Promise.all(reports.map((r) => waitFor(() => readJson<{ pid: number }>(r), 10_000, 'the program')));
    if (process.platform !== 'win32') {
      expect(processGroupOf(a!.pid)).toBe(a!.pid);
      expect(processGroupOf(b!.pid)).toBe(processGroupOf(process.pid));
    }
    await Promise.all([own.kill(), inCaller.kill()]);
    await waitFor(() => !isAlive(a!.pid) && !isAlive(b!.pid), 5000, 'both to die');
  });

  test('a program that cannot be started says why, without throwing', async () => {
    const p = startProgram(join(tmp(), 'missing'), [], { cwd: tmp(), env: env() });
    expect((await p.exited).spawnError).toBe('ENOENT');
  });

  test('a hard quit (second Ctrl+C) ends the program tree and writes done', async () => {
    const files = new LeaseFiles(tmp(), 'JOB1');
    const pids = join(tmp(), 'pids.json');
    const p = startProgram(process.execPath, [LEASE_PROGRAM, '--tree', pids, '--forever'], {
      cwd: tmp(), env: env(), killGraceMs: 500, onHardQuit: () => void files.done('S1'),
    });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the tree');
    await killRunning(3000);
    await p.exited;
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect(readFileSync(join(files.dir, 'done'), 'utf8')).toBe('S1');
  });
});

describe('the lease files', () => {
  test('alive and done hold the claim; folders untouched for a day are swept, a folder with a fresh file stays', () => {
    const root = tmp();
    const f = new LeaseFiles(root, 'JOB1');
    expect(f.alive('S1')).toBe(true);
    expect(f.done('S1')).toBe(true);
    expect(readFileSync(join(root, 'JOB1', 'alive'), 'utf8')).toBe('S1');
    const twoDays = new Date(Date.now() - 2 * 86_400_000);
    const old = join(root, 'OLD');
    mkdirSync(old);
    utimesSync(old, twoDays, twoDays);
    const kept = join(root, 'KEPT');
    mkdirSync(kept);
    writeFileSync(join(kept, 'alive'), 'S1');
    utimesSync(kept, twoDays, twoDays);
    sweepLeases(root);
    expect([existsSync(old), existsSync(kept), existsSync(f.dir)]).toEqual([false, true, true]);
  });

  test('a file that cannot be written is reported, not thrown', () => {
    const root = tmp();
    writeFileSync(join(root, 'JOB1'), 'a file where the folder should be');
    expect(new LeaseFiles(root, 'JOB1').alive('S1')).toBe(false);
  });
});
