import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { loadPacks, missingTools, type Pack } from './pack.js';
import { childEnv, logTail, runProcess } from './process.js';
import { expandArgv } from './template.js';

/** A type's check may take this long (loading a model, asking the GPU) before it counts as failed. */
export const CHECK_TIMEOUT_MS = 120_000;

/** Node cannot spawn a batch file without a shell (EINVAL), and no shell is ever used. */
export const isBatchFile = (cmd: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);

/** Where a tool from worker.yaml points, or null when nothing is there. Bare names are looked up on PATH; on Windows only real executables count (no .cmd/.bat). */
export function findTool(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd) ? cmd : null;
  const pathExt = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e && !/^\.(cmd|bat)$/i.test(e));
  const exts = platform === 'win32' ? ['', ...pathExt] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (!isBatchFile(p, platform) && existsSync(p)) return p;
    }
  }
  return null;
}

export type CheckOptions = { timeoutMs?: number; killGraceMs?: number; signal?: AbortSignal };

/** Why this pack cannot be offered now, or null when it is ready: its tools exist and its check exits 0 in time. */
export async function checkPack(pack: Pack, tools: Record<string, string>, opts: CheckOptions = {}): Promise<string | null> {
  const missing = missingTools(pack, tools);
  if (missing.length) return `tools missing in worker.yaml: ${missing.join(', ')}`;
  for (const name of pack.impl.tools) {
    if (isBatchFile(tools[name]!)) return `tool ${name}: ${tools[name]} is a batch file; point worker.yaml at the real executable`;
    if (!findTool(tools[name]!)) return `tool ${name}: ${tools[name]} was not found`;
  }
  if (!pack.impl.check) return null;
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const r = await runProcess({
    argv: expandArgv(pack.impl.check, { pack: pack.dir, tools }),
    cwd: pack.dir,
    env: childEnv(process.env, {}),
    timeoutMs,
    killGraceMs: opts.killGraceMs,
    signal: opts.signal,
  });
  const tail = logTail(r.log);
  if (r.spawnError) return `check could not start: ${r.spawnError}`;
  if (r.canceled) return 'check was interrupted';
  if (r.timedOut) return `check did not finish within ${timeoutMs / 1000} s`;
  if (r.code !== 0) return `check failed (exit code ${r.code ?? r.signal})${tail ? `: ${tail}` : ''}`;
  return null;
}

/** Load every pack and run its check; the ready ones can be announced. */
export async function preparePacks(typesDir: string, tools: Record<string, string>, opts: CheckOptions = {}): Promise<{ ready: Pack[]; problems: string[] }> {
  const { packs, errors } = loadPacks(typesDir);
  const ready: Pack[] = [];
  const problems = [...errors];
  for (const pack of packs) {
    const problem = await checkPack(pack, tools, opts);
    if (problem) problems.push(`type pack ${pack.contract.name}: ${problem}`);
    else ready.push(pack);
  }
  return { ready, problems };
}

/** Changes when a pack directory appears or goes, or a type.yaml is rewritten: the running worker then reloads. */
export function packsSignature(typesDir: string): string {
  if (!existsSync(typesDir)) return '';
  return readdirSync(typesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const file = join(typesDir, d.name, 'type.yaml');
      return `${d.name}:${existsSync(file) ? statSync(file).mtimeMs : 0}`;
    })
    .sort()
    .join('|');
}
