import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { jobDirs, resolvePaths } from '../src/paths.js';

describe('resolvePaths', () => {
  test('Windows: config in APPDATA (roaming), data in LOCALAPPDATA', () => {
    const p = resolvePaths({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u');
    expect(p).toEqual({
      configDir: 'C:\\Users\\u\\AppData\\Roaming\\fornax',
      dataDir: 'C:\\Users\\u\\AppData\\Local\\fornax',
      configFile: 'C:\\Users\\u\\AppData\\Roaming\\fornax\\worker.yaml',
      tokenFile: 'C:\\Users\\u\\AppData\\Roaming\\fornax\\token',
      typesDir: 'C:\\Users\\u\\AppData\\Local\\fornax\\types',
      jobsDir: 'C:\\Users\\u\\AppData\\Local\\fornax\\jobs',
    });
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

  test('job directories', () => {
    const p = resolvePaths({ FORNAX_CONFIG_DIR: join(process.cwd(), 'c'), FORNAX_DATA_DIR: join(process.cwd(), 'd') });
    const root = join(p.jobsDir, '01JOB');
    expect(jobDirs(p, '01JOB')).toEqual({ root, in: join(root, 'in'), out: join(root, 'out'), work: join(root, 'work') });
  });
});
