import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export type Paths = {
  /** worker.yaml and the token. */
  configDir: string;
  /** Type packs and job directories. */
  dataDir: string;
  configFile: string;
  tokenFile: string;
  typesDir: string;
  jobsDir: string;
};

export type JobDirs = { root: string; in: string; out: string; work: string };

/**
 * Spec 7.2. Windows: config in %APPDATA%\fornax, data in %LOCALAPPDATA%\fornax. Linux: $XDG_CONFIG_HOME/fornax and
 * $XDG_DATA_HOME/fornax (defaults ~/.config, ~/.local/share). FORNAX_CONFIG_DIR / FORNAX_DATA_DIR override both.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): Paths {
  const p = platform === 'win32' ? win32 : posix;
  // Relative values are ignored, as the XDG base directory spec asks.
  const abs = (v: string | undefined) => (v && p.isAbsolute(v) ? v : undefined);
  const configDir = env.FORNAX_CONFIG_DIR
    ? p.resolve(env.FORNAX_CONFIG_DIR)
    : platform === 'win32'
      ? p.join(abs(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming'), 'fornax')
      : p.join(abs(env.XDG_CONFIG_HOME) ?? p.join(home, '.config'), 'fornax');
  const dataDir = env.FORNAX_DATA_DIR
    ? p.resolve(env.FORNAX_DATA_DIR)
    : platform === 'win32'
      ? p.join(abs(env.LOCALAPPDATA) ?? p.join(home, 'AppData', 'Local'), 'fornax')
      : p.join(abs(env.XDG_DATA_HOME) ?? p.join(home, '.local', 'share'), 'fornax');
  return {
    configDir,
    dataDir,
    configFile: p.join(configDir, 'worker.yaml'),
    tokenFile: p.join(configDir, 'token'),
    typesDir: p.join(dataDir, 'types'),
    jobsDir: p.join(dataDir, 'jobs'),
  };
}

/**
 * The directory of one claim of a job: `<id>-<12 hex digits of the lease's SHA-256>`. Every claim gets a new lease,
 * so a directory a leftover process of an earlier claim still holds never blocks a later one (a released claim gets
 * its attempt back, so the attempt number alone could repeat). The lease itself stays out of paths the tool sees.
 * The id must already be checked to be a plain name.
 */
export function jobDirName(id: string, lease: string): string {
  return `${id}-${createHash('sha256').update(lease).digest('hex').slice(0, 12)}`;
}

/** <data>/jobs/<id>-<lease hash>/{in,out,work}: see jobDirName. */
export function jobDirs(paths: Paths, id: string, lease: string): JobDirs {
  const root = join(paths.jobsDir, jobDirName(id, lease));
  return { root, in: join(root, 'in'), out: join(root, 'out'), work: join(root, 'work') };
}
