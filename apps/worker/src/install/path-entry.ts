import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** The registry kind of the user Path: REG_SZ or REG_EXPAND_SZ (entries like `%USERPROFILE%\bin`). */
export type PathKind = 'String' | 'ExpandString';

/** Anything but 'String' is 'ExpandString': the kind Windows itself gives a new user Path. */
const pathKind = (s: string | undefined): PathKind => (s === 'String' ? 'String' : 'ExpandString');

/** `%NAME%` replaced from `env` (names without case, as Windows does); unknown names stay as they are. */
function expandWindows(p: string, env: NodeJS.ProcessEnv): string {
  const vars = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return p.replace(/%([^%;]+)%/g, (whole, name: string) => vars.get(name.toLowerCase()) ?? whole);
}

/**
 * The user Path with `dir` appended, or null when it already holds it. Entries are compared expanded, without
 * case and without a trailing backslash; the result keeps every entry exactly as read (unexpanded).
 */
export function mergeUserPath(current: string | null, dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const norm = (p: string) => expandWindows(p, env).trim().replace(/\\+$/, '').toLowerCase();
  const parts = (current ?? '').split(';').filter((p) => p.trim() !== '');
  if (parts.some((p) => norm(p) === norm(dir))) return null;
  return [...parts, dir].join(';');
}

/**
 * Run a Windows PowerShell command and return its stdout. Windows PowerShell 5.1 writes piped output in the
 * console (OEM) code page, so the command first switches it to UTF-8; values travel in environment variables,
 * never in the command text.
 */
export function psOut(command: string, extraEnv: Record<string, string> = {}): string {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, ...extraEnv } },
  );
  if (r.error) throw new Error(`powershell.exe: ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}`);
  if (r.status !== 0) throw new Error(`powershell.exe exit code ${r.status}`);
  return r.stdout;
}

/** The user Path straight from the registry, `%VAR%` entries unexpanded, with its kind (first line) and value (second). */
export function readUserPathRaw(): { value: string | null; kind: PathKind } {
  const out = psOut(
    "$k = Get-Item 'HKCU:\\Environment'; $v = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames'); " +
      "$kind = if ($null -ne $v) { $k.GetValueKind('Path') } else { 'ExpandString' }; Write-Output $kind; Write-Output $v",
  ).replace(/\r?\n$/, '');
  const nl = out.indexOf('\n');
  const kind = pathKind((nl < 0 ? out : out.slice(0, nl)).replace(/\r$/, ''));
  const value = nl < 0 ? '' : out.slice(nl + 1);
  return { value: value === '' ? null : value, kind };
}

/** Write the user Path with the kind it had; the set-and-clear of a variable through .NET tells running programs (Explorer, new terminals) that the environment changed. */
function writeUserPathRaw(value: string, kind: PathKind): void {
  psOut(
    "Set-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $env:FORNAX_NEW_PATH -Type $env:FORNAX_PATH_KIND; " +
      "[Environment]::SetEnvironmentVariable('FORNAX_PATH_CHANGED', '1', 'User'); [Environment]::SetEnvironmentVariable('FORNAX_PATH_CHANGED', $null, 'User')",
    { FORNAX_NEW_PATH: value, FORNAX_PATH_KIND: pathKind(kind) },
  );
}

export type PathDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readUserPath?: () => { value: string | null; kind: PathKind };
  writeUserPath?: (value: string, kind: PathKind) => void;
};

/** Put `fornax` on PATH (spec 05c 3 step 3); the lines say what happened. Never throws: the program is installed anyway. */
export function addToPath(appDir: string, deps: PathDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform === 'win32') {
    try {
      const { value, kind } = (deps.readUserPath ?? readUserPathRaw)();
      const merged = mergeUserPath(value, appDir, env);
      if (merged === null) return [`fornax is on your Path (${appDir})`];
      (deps.writeUserPath ?? writeUserPathRaw)(merged, kind);
      return [`added ${appDir} to your Path; open a new terminal to use fornax`];
    } catch (e) {
      return [
        `WARN  could not add ${appDir} to your Path (${(e as Error).message}); add it by hand:`,
        `  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${appDir.replaceAll("'", "''")}', 'User')`,
      ];
    }
  }
  const home = deps.home ?? homedir();
  const bin = join(home, '.local', 'bin');
  const link = join(bin, 'fornax');
  const target = join(appDir, 'fornax');
  // A link into the data directory (`app`, `app.old`, a former layout) is ours and is replaced; anything else is foreign.
  const dataDir = resolve(appDir, '..');
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
    if (foreign || (current !== null && current !== dataDir && !current.startsWith(dataDir + sep))) {
      return [`WARN  ${link} exists and is not a link to ${target}; remove it, or run ${target} directly`];
    }
    if (current !== target) {
      if (current !== null) unlinkSync(link);
      symlinkSync(target, link);
    }
  } catch (e) {
    return [`WARN  could not link ${link} to ${target} (${(e as NodeJS.ErrnoException).code ?? 'error'}); run ${target} directly`];
  }
  const onPath = (env.PATH ?? '').split(':').filter((p) => p !== '').some((p) => resolve(p) === resolve(bin));
  if (onPath) lines.push(`fornax is on your PATH (${link})`);
  else {
    lines.push(`linked ${link} to ${target}`);
    lines.push('~/.local/bin is not on your PATH yet: log in again (Debian and Ubuntu add it once it exists), or add this line to ~/.profile:');
    lines.push('  export PATH="$HOME/.local/bin:$PATH"');
  }
  return lines;
}
