import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { loadPacks, missingTools, type Pack, type PackProblem } from './pack.js';
import { runProcess } from './process.js';
import { expandArgv } from './template.js';
import { packEnv, type SecretDirs, toolEnv } from './tool-env.js';

/** A type's check may take this long (loading a model, asking the GPU) before it counts as failed. */
export const CHECK_TIMEOUT_MS = 120_000;

/** Node cannot spawn a batch file without a shell (EINVAL), and no shell is ever used. */
export const isBatchFile = (cmd: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);

/**
 * Windows, as libuv's spawn searches: the name as given (only when it has an extension), then with .com, then .exe
 * appended; only a .com or .exe can be started without a shell.
 */
const WINDOWS_SUFFIXES = ['', '.com', '.exe'];
const WINDOWS_RUNNABLE = new Set(['.com', '.exe']);

/** A file the OS can start: on Windows by its extension, elsewhere by its executable bit. */
const isRunnable = (p: string, platform: NodeJS.Platform): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform === 'win32') return WINDOWS_RUNNABLE.has(extname(p).toLowerCase());
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * One console-safe line: control characters (and so line breaks) become spaces, at most `max` characters. Characters
 * are code points: a cut through a surrogate pair would leave a lone half that JSON parsers (serde_json) reject.
 */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/**
 * Where a tool from worker.yaml points, or null when nothing startable is there. Bare names are looked up on PATH.
 * Windows: only what spawn starts without a shell (a .com or .exe, found as spawn finds it; never .cmd/.bat/.py).
 * Linux: the file must be executable.
 */
export function findTool(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const suffixes = platform === 'win32' ? WINDOWS_SUFFIXES : [''];
  const first = (base: string) => suffixes.map((s) => base + s).find((p) => isRunnable(p, platform)) ?? null;
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return first(cmd);
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = first(join(dir, cmd));
    if (p) return p;
  }
  return null;
}

/** A bare name that exists on PATH only as a .cmd/.bat (win32): the caller can say so instead of "not found". */
export function findBatchOnly(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32' || isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\') || findTool(cmd, env, platform)) return null;
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of ['.cmd', '.bat']) {
      const p = join(dir, cmd + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

export type CheckOptions = { timeoutMs?: number; killGraceMs?: number; signal?: AbortSignal };

/** Spec 12 § 2.1: a check's stdout line that says what the type runs with; the last one counts. */
export const ENVIRONMENT_PREFIX = 'fornax-environment:';
/** The longest unfinished stdout line kept while scanning: a longer one cannot be a short environment line. */
const KEEP_LINE = 65_536;

/** Reads a check's stdout as it comes and keeps only its last environment line, so any amount of output after it is fine. */
class EnvironmentScan {
  private line = '';
  private overlong = false;
  private found: string | null = null;

  push(text: string): void {
    const parts = (this.line + text).split(/\n/);
    this.line = parts.pop()!;
    for (const part of parts) {
      if (!this.overlong) this.see(part);
      this.overlong = false;
    }
    if (this.line.length > KEEP_LINE) {
      this.line = '';
      this.overlong = true;
    }
  }

  result(): string | null {
    if (!this.overlong) this.see(this.line);
    return this.found === null ? null : environmentOf(this.found);
  }

  private see(line: string): void {
    if (line.trim().startsWith(ENVIRONMENT_PREFIX)) this.found = line;
  }
}

/** The text of the last `fornax-environment:` line, one console-safe line of at most 200 characters; null without one. */
export function environmentOf(stdout: string): string | null {
  let found: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(ENVIRONMENT_PREFIX)) found = line.slice(ENVIRONMENT_PREFIX.length);
  }
  const text = found === null ? '' : oneLine(found, 200);
  return text || null;
}

export type CheckResult = { problem: string | null; environment: string | null };

/** Why this pack cannot be offered now (null when ready: its tools exist and its check exits 0 in time), and its environment line. */
export async function runCheck(pack: Pack, tools: Record<string, string>, dirs: SecretDirs, opts: CheckOptions = {}): Promise<CheckResult> {
  const not = (problem: string): CheckResult => ({ problem, environment: null });
  const missing = missingTools(pack, tools);
  if (missing.length) return not(`tools missing in worker.yaml: ${missing.join(', ')}`);
  for (const name of pack.impl.tools) {
    if (isBatchFile(tools[name]!) || findBatchOnly(tools[name]!)) return not(`tool ${name}: ${tools[name]} is a batch file; point worker.yaml at the real executable`);
    if (!findTool(tools[name]!)) return not(`tool ${name}: ${tools[name]} was not found`);
  }
  if (!pack.impl.check) return { problem: null, environment: null };
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const scan = new EnvironmentScan();
  const r = await runProcess({
    argv: expandArgv(pack.impl.check, { pack: pack.dir, tools }),
    cwd: pack.dir,
    env: toolEnv(dirs, packEnv(pack.dir)),
    timeoutMs,
    killGraceMs: opts.killGraceMs,
    signal: opts.signal,
    onOutput: (text, stream) => {
      if (stream === 'stdout') scan.push(text);
    },
  });
  const tail = oneLine(r.log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '');
  if (r.spawnError) return not(`check could not start: ${r.spawnError}`);
  if (r.canceled) return not('check was interrupted');
  if (r.timedOut) return not(`check did not finish within ${timeoutMs / 1000} s`);
  if (r.code !== 0) return not(`check failed (exit code ${r.code ?? r.signal})${tail ? `: ${tail}` : ''}`);
  return { problem: null, environment: scan.result() };
}

/** Why this pack cannot be offered now, or null when it is ready. */
export async function checkPack(pack: Pack, tools: Record<string, string>, dirs: SecretDirs, opts: CheckOptions = {}): Promise<string | null> {
  return (await runCheck(pack, tools, dirs, opts)).problem;
}

/** Load every pack and run its check; the ready ones can be announced (with their environment lines), the others say why not. */
export async function preparePacks(
  dirs: SecretDirs, tools: Record<string, string>, opts: CheckOptions = {},
): Promise<{ ready: Pack[]; problems: PackProblem[]; environments: Record<string, string> }> {
  const { packs, failed } = loadPacks(dirs.typesDir);
  const ready: Pack[] = [];
  const environments: Record<string, string> = {};
  const problems: PackProblem[] = failed.map((f) => ({ name: f.name, reason: oneLine(f.reason) }));
  for (const pack of packs) {
    if (opts.signal?.aborted) break;
    const { problem, environment } = await runCheck(pack, tools, dirs, opts);
    if (problem) {
      problems.push({ name: pack.contract.name, reason: problem });
      continue;
    }
    ready.push(pack);
    if (environment !== null) environments[pack.contract.name] = environment;
  }
  return { ready, problems, environments };
}

/** The marker of an installed pack: its origin and whether its setup is still pending (install/packs.ts). */
export const ORIGIN_FILE = '.fornax-pack.json';

/** The marker's text, '' when it is missing or unreadable. */
const markerText = (dir: string): string => {
  try {
    return readFileSync(join(dir, ORIGIN_FILE), 'utf8').trim();
  } catch {
    return '';
  }
};

/**
 * Changes when a pack directory appears or goes, a type.yaml is rewritten, or a pack's marker changes (its setup
 * ended): the running worker then reloads. fornax types install copies a pack in before its setup runs, so a check
 * made meanwhile fails; the marker is what tells the worker to check it again.
 */
export function packsSignature(typesDir: string): string {
  if (!existsSync(typesDir)) return '';
  return readdirSync(typesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(typesDir, d.name);
      const file = join(dir, 'type.yaml');
      return `${d.name}:${existsSync(file) ? statSync(file).mtimeMs : 0}:${markerText(dir)}`;
    })
    .sort()
    .join('|');
}
