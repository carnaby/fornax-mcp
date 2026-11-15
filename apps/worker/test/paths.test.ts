import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { jobDirName, jobDirs, resolvePaths } from '../src/paths.js';

describe('resolvePaths', () => {
  test('Windows: config in APPDATA (roaming), data in LOCALAPPDATA', () => {
    const p = resolvePaths({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u');
    expect(p).toEqual({
      configDir: 'C:\\Users\\u\\AppData\\Roaming\\fornax',
      dataDir: 'C:\\Users\\u\\AppData\\Local\\fornax',
      configFile: 'C:\\Users\\u\\AppData\\Roaming\\fornax\\worker.yaml',
      tokenFile: 'C:\\Users\\u\\AppData\\Roaming\\fornax\\token',
      clientTokenFile: 'C:\\Users\\u\\AppData\\Roaming\\fornax\\client-token',
      typesDir: 'C:\\Users\\u\\AppData\\Local\\fornax\\types',
      jobsDir: 'C:\\Users\\u\\AppData\\Local\\fornax\\jobs',
      leasesDir: 'C:\\Users\\u\\AppData\\Local\\fornax\\leases',
      appDir: 'C:\\Users\\u\\AppData\\Local\\fornax\\app',
      restartFile: 'C:\\Users\\u\\AppData\\Local\\fornax\\restart',
    });
  });

  test('the app folder and the restart request live in the data directory (spec 05c 2)', () => {
    const p = resolvePaths({}, 'linux', '/home/u');
    expect([p.appDir, p.restartFile]).toEqual(['/home/u/.local/share/fornax/app', '/home/u/.local/share/fornax/restart']);
  });

  test('Windows without the variables falls back to the profile', () => {
    const p = resolvePaths({}, 'win32', 'C:\\Users\\u');
    expect([p.configDir, p.dataDir]).toEqual(['C:\\Users\\u\\AppData\\Roaming\\fornax', 'C:\\Users\\u\\AppData\\Local\\fornax']);
  });

  test('Linux: XDG directories', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: '/home/u/.cfg', XDG_DATA_HOME: '/home/u/.data' }, 'linux', '/home/u');
    expect([p.configDir, p.tokenFile, p.typesDir]).toEqual(['/home/u/.cfg/fornax', '/home/u/.cfg/fornax/token', '/home/u/.data/fornax/types']);
  });

  test('Linux defaults; relative XDG values are ignored', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: 'relative', XDG_DATA_HOME: '' }, 'linux', '/home/u');
    expect([p.configDir, p.dataDir]).toEqual(['/home/u/.config/fornax', '/home/u/.local/share/fornax']);
  });

  test('FORNAX_CONFIG_DIR and FORNAX_DATA_DIR win', () => {
    const root = join(process.cwd(), 'somewhere');
    const p = resolvePaths({ FORNAX_CONFIG_DIR: join(root, 'c'), FORNAX_DATA_DIR: join(root, 'd'), APPDATA: 'x', XDG_CONFIG_HOME: '/x' });
    expect([p.configDir, p.jobsDir]).toEqual([join(root, 'c'), join(root, 'd', 'jobs')]);
  });

  test('job directories: one per claim, named by the id and a hash of the lease (never the lease itself)', () => {
    const p = resolvePaths({ FORNAX_CONFIG_DIR: join(process.cwd(), 'c'), FORNAX_DATA_DIR: join(process.cwd(), 'd') });
    const name = jobDirName('01JOB', 'lease-1');
    expect(name).toMatch(/^01JOB-[0-9a-f]{12}$/);
    expect(name).not.toContain('lease');
    expect(jobDirName('01JOB', 'lease-2')).not.toBe(name);
    expect(jobDirName('01JOB', 'lease-1')).toBe(name);
    const root = join(p.jobsDir, name);
    expect(jobDirs(p, '01JOB', 'lease-1')).toEqual({ root, in: join(root, 'in'), out: join(root, 'out'), work: join(root, 'work') });
  });
});
