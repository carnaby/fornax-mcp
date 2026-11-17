import { loadPacks } from './pack.js';
import type { Paths } from './paths.js';
import { childEnv } from './process.js';
import { storedSecretNames } from './secrets.js';

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
