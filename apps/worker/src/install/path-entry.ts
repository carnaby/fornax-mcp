import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The user Path with `dir` appended, or null when it already holds it (Windows compares paths without case). */
export function mergeUserPath(current: string | null, dir: string): string | null {
  const norm = (p: string) => p.trim().replace(/\\+$/, '').toLowerCase();
  const parts = (current ?? '').split(';').filter((p) => p.trim() !== '');
  if (parts.some((p) => norm(p) === norm(dir))) return null;
  return [...parts, dir].join(';');
}

/** PowerShell reads and writes the user (not the merged) Path; the value travels in an environment variable, never in the command text. */
function powershell(command: string, extraEnv: Record<string, string> = {}): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, ...extraEnv },
  });
  if (r.error) throw new Error(`powershell.exe: ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}`);
  if (r.status !== 0) throw new Error(`powershell.exe exit code ${r.status}`);
  return r.stdout;
}

const readUserPathPs = (): string | null => {
  const v = powershell("[Environment]::GetEnvironmentVariable('Path', 'User')").replace(/\r?\n$/, '');
  return v === '' ? null : v;
};
// SetEnvironmentVariable(..., 'User') also tells running programs (Explorer, new terminals) that the environment changed.
const writeUserPathPs = (value: string): void => {
  powershell("[Environment]::SetEnvironmentVariable('Path', $env:FORNAX_NEW_PATH, 'User')", { FORNAX_NEW_PATH: value });
};

export type PathDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readUserPath?: () => string | null;
  writeUserPath?: (value: string) => void;
};

/** Put `fornax` on PATH (spec 05c 3 step 3); the lines say what happened. Never throws: the program is installed anyway. */
export function addToPath(appDir: string, deps: PathDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    try {
      const merged = mergeUserPath((deps.readUserPath ?? readUserPathPs)(), appDir);
      if (merged === null) return [`fornax is on your Path (${appDir})`];
      (deps.writeUserPath ?? writeUserPathPs)(merged);
      return [`added ${appDir} to your Path; open a new terminal to use fornax`];
    } catch (e) {
      return [
        `WARN  could not add ${appDir} to your Path (${(e as Error).message}); add it by hand:`,
        `  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${appDir}', 'User')`,
      ];
    }
  }
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const bin = join(home, '.local', 'bin');
  const link = join(bin, 'fornax');
  const target = join(appDir, 'fornax');
  const lines: string[] = [];
  try {
    mkdirSync(bin, { recursive: true });
    let current: string | null = null;
    let foreign = false;
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink()) current = resolve(bin, readlinkSync(link));
      else foreign = true;
    } catch {
      // No such file: made below.
    }
    if (foreign || (current !== null && !current.startsWith(resolve(appDir, '..')))) {
      return [`WARN  ${link} exists and is not a link to ${target}; remove it, or run ${target} directly`];
    }
    if (current !== target) {
      if (current !== null) unlinkSync(link);
      symlinkSync(target, link);
    }
  } catch (e) {
    return [`WARN  could not link ${link} to ${target} (${(e as NodeJS.ErrnoException).code ?? 'error'}); run ${target} directly`];
  }
  const onPath = (env.PATH ?? '').split(':').some((p) => resolve(p) === resolve(bin));
  if (onPath) lines.push(`fornax is on your PATH (${link})`);
  else {
    lines.push(`linked ${link} to ${target}`);
    lines.push('~/.local/bin is not on your PATH yet: log in again (Debian and Ubuntu add it once it exists), or add this line to ~/.profile:');
    lines.push('  export PATH="$HOME/.local/bin:$PATH"');
  }
  return lines;
}
