import { join } from 'node:path';
import { loadPacks, type Pack } from './pack.js';
import type { Paths } from './paths.js';
import { childEnv } from './process.js';
import { readSecret, storedSecretNames } from './secrets.js';

/** Where the secrets and the installed packs are: every tool's environment depends on both (spec 08 § 4.2). */
export type SecretDirs = Pick<Paths, 'secretsDir' | 'typesDir'>;

/**
 * Spec 08 § 4.2: the names (upper case) no tool inherits from the worker: every stored secret, every secret a loadable
 * installed pack asks for, and `also`. Computed for each process, so a secret stored meanwhile counts at once.
 */
export function hiddenNames(dirs: SecretDirs, also: readonly string[] = []): Set<string> {
  const names = new Set<string>();
  for (const n of storedSecretNames(dirs.secretsDir)) names.add(n.toUpperCase());
  for (const p of loadPacks(dirs.typesDir).packs) for (const n of p.impl.secrets) names.add(n.toUpperCase());
  for (const n of also) names.add(n.toUpperCase());
  return names;
}

/** The environment of a check or a job's tool: no FORNAX_* and no secret's name from the worker, plus `extra`. */
export function toolEnv(dirs: SecretDirs, extra: Record<string, string> = {}): Record<string, string> {
  return childEnv(process.env, hiddenNames(dirs), extra);
}

/**
 * Spec 12 § 5.8: every setup, check and job of a pack keeps Python's bytecode caches in the pack's env/pycache, so
 * scripts/ stays as shipped. Not -B: that would also stop caching the libraries (uv does not compile them) and does
 * not reach the Python processes a script starts. Blender's and Node's tools ignore it.
 */
export function packEnv(packDir: string): Record<string, string> {
  return { PYTHONPYCACHEPREFIX: join(packDir, 'env', 'pycache') };
}

/**
 * Spec 08 § 4.2: a pack's setup environment (the tool environment, the pack's Python cache folder and the stored
 * secrets the pack declares) and the secret values given, to mask in its output. A damaged secret file throws
 * readSecret's ConfigError.
 */
export function setupEnv(dirs: SecretDirs, pack: Pack, dir: string = pack.dir): { env: Record<string, string>; values: string[] } {
  const extra: Record<string, string> = {};
  for (const name of pack.impl.secrets) {
    const value = readSecret(dirs.secretsDir, name);
    if (value !== null) extra[name] = value;
  }
  return { env: childEnv(process.env, hiddenNames(dirs, pack.impl.secrets), { ...packEnv(dir), ...extra }), values: Object.values(extra) };
}
