import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { checkPack } from '../checks.js';
import { lockWorker } from '../instance.js';
import { loadPack, type Pack } from '../pack.js';
import type { Paths } from '../paths.js';
import { removeDir, SKIP_PARTS, swapDir } from './app.js';
import { runPackSetup } from './pack-setup.js';

/** Spec 05c 4.4: where an installed pack came from. */
export const ORIGIN_FILE = '.fornax-pack.json';
export type PackOrigin = 'shipped' | 'dir';

export function writeOrigin(dir: string, origin: PackOrigin): void {
  writeFileSync(join(dir, ORIGIN_FILE), `${JSON.stringify({ source: origin })}\n`);
}

/** The marker's origin; null without a (readable) marker. */
function readOrigin(dir: string): PackOrigin | null {
  try {
    const s = (JSON.parse(readFileSync(join(dir, ORIGIN_FILE), 'utf8')) as { source?: unknown }).source;
    return s === 'shipped' || s === 'dir' ? s : null;
  } catch {
    return null;
  }
}

/** Pack directories (holding type.yaml) by name; <name>.new and <name>.old are what a failed swap left, not packs. */
function packDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/\.(new|old)$/.test(d.name) && existsSync(join(root, d.name, 'type.yaml')))
    .map((d) => d.name)
    .sort();
}

/** relative path → sha256 of every file that is the pack's own (not env/, caches, tests or the marker). */
function packFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join('/');
      if (rel.split('/').some((part) => SKIP_PARTS.has(part)) || rel === ORIGIN_FILE) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return files;
}

const sameFiles = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** The files a setup runs: arguments of the form {pack}/<path>. */
const setupFiles = (pack: Pack): string[] =>
  (pack.impl.setup ?? []).flatMap((a) => {
    const m = /^\{pack\}\/(.+)$/.exec(a);
    return m ? [m[1]!] : [];
  });

/** Spec 05c 4.4: the setup runs again when the type's version, its setup command or a file it runs changed. */
function setupNeeded(oldDir: string, oldFiles: Map<string, string>, next: Pack, nextFiles: Map<string, string>): boolean {
  if (!next.impl.setup) return false;
  let old: Pack;
  try {
    old = loadPack(oldDir);
  } catch {
    return true;
  }
  if (old.contract.version !== next.contract.version) return true;
  if (JSON.stringify(old.impl.setup ?? null) !== JSON.stringify(next.impl.setup)) return true;
  return setupFiles(next).some((f) => oldFiles.get(f) !== nextFiles.get(f));
}

export type SyncOptions = {
  shippedDir: string;
  typesDir: string;
  tools: Record<string, string>;
  out: (line: string) => void;
  write?: (text: string) => void;
  signal: AbortSignal;
  setupTimeoutMs?: number;
  checkTimeoutMs?: number;
};

/**
 * Bring every installed built-in pack up to the shipped one (spec 05c 4.4). Only under the worker lock: a running job
 * runs from its pack's scripts. env/ is kept; the setup runs again only when setupNeeded says so.
 */
export async function syncShippedPacks(o: SyncOptions): Promise<void> {
  const shipped = new Set(packDirs(o.shippedDir));
  const installed = packDirs(o.typesDir);
  for (const name of installed) {
    const dir = join(o.typesDir, name);
    const origin = readOrigin(dir);
    if (!shipped.has(name)) {
      if (origin === 'shipped') o.out(`WARN  ${name} is no longer shipped`);
      continue;
    }
    if (origin === 'dir') continue;
    const source = join(o.shippedDir, name);
    const oldFiles = packFiles(dir);
    const newFiles = packFiles(source);
    if (sameFiles(oldFiles, newFiles)) {
      if (origin === null) writeOrigin(dir, 'shipped');
      continue;
    }
    let next: Pack;
    try {
      next = loadPack(source);
    } catch {
      o.out(`WARN  ${name}: the shipped pack cannot be read; the installed one stays`);
      continue;
    }
    const needSetup = setupNeeded(dir, oldFiles, next, newFiles);
    const stage = `${dir}.new`;
    removeDir(stage);
    cpSync(source, stage, { recursive: true, filter: (src) => !relative(source, src).split(sep).some((part) => SKIP_PARTS.has(part)) });
    const env = join(dir, 'env');
    const hadEnv = existsSync(env);
    if (hadEnv) renameSync(env, join(stage, 'env'));
    writeOrigin(stage, 'shipped');
    try {
      swapDir(stage, dir);
    } catch (e) {
      // dir is missing only when even the old pack could not be put back (<dir>.old holds it): the stage, with env/,
      // then stays as it is.
      if (existsSync(dir)) {
        if (hadEnv) renameSync(join(stage, 'env'), env);
        removeDir(stage);
      }
      o.out(`WARN  ${name}: ${(e as Error).message}`);
      continue;
    }
    // A newer mtime than before: the loop's packsSignature changes and the running worker checks the pack again.
    const yaml = join(dir, 'type.yaml');
    const t = Math.max(Date.now(), statSync(yaml).mtimeMs + 1000) / 1000;
    utimesSync(yaml, t, t);
    o.out(`updated type ${name}`);
    if (needSetup) {
      o.out(`running the setup of ${name}…`);
      const why = await runPackSetup({ pack: loadPack(dir), dir, tools: o.tools, signal: o.signal, write: o.write, timeoutMs: o.setupTimeoutMs });
      if (why) {
        o.out(`WARN  ${name}: setup failed (${why}); the type is not ready (fornax doctor)`);
        continue;
      }
    }
    const problem = await checkPack(loadPack(dir), o.tools, { signal: o.signal, timeoutMs: o.checkTimeoutMs });
    if (problem) o.out(`WARN  ${name} is not ready: ${problem}`);
  }
  for (const name of shipped) if (!installed.includes(name)) o.out(`new type ${name}: fornax types install ${name}`);
}

/** Sync the packs when no worker runs (spec 05c 4.4); 'worker-running' leaves them to the worker's next start. */
export async function syncPacksUnderLock(paths: Paths, o: Omit<SyncOptions, 'typesDir'>): Promise<'synced' | 'worker-running'> {
  const lock = lockWorker(paths);
  if (!('release' in lock)) return 'worker-running';
  try {
    await syncShippedPacks({ ...o, typesDir: paths.typesDir });
    return 'synced';
  } finally {
    lock.release();
  }
}
