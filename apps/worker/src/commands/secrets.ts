import { readFileSync, statSync } from 'node:fs';
import { readAllLimited, readHiddenLine, type SecretInput } from '../hidden-input.js';
import { loadPacks } from '../pack.js';
import { checkSecretName, parseSecretValue, removeSecret, storedSecretNames, writeSecret } from '../secrets.js';
import type { Ctx } from './context.js';

/** Spec 08 § 3.1: more input than this is not a token. */
export const MAX_SECRET_INPUT = 64 * 1024;

/** The terminal asks without echo; a pipe is read whole. */
export async function defaultSecretInput(prompt: string): Promise<SecretInput> {
  if (process.stdin.isTTY) {
    const line = await readHiddenLine(process.stdin, process.stderr, prompt);
    return line === null ? { canceled: true } : { raw: line };
  }
  const all = await readAllLimited(process.stdin, MAX_SECRET_INPUT);
  return all === null ? { tooLong: true } : { raw: all };
}

/** Installed packs whose setup asks for each secret name (in the packs' name order). */
function wanted(ctx: Ctx): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const p of loadPacks(ctx.paths.typesDir).packs) for (const n of p.impl.secrets) by.set(n, [...(by.get(n) ?? []), p.contract.name]);
  return by;
}

function fromFile(path: string): SecretInput | { unreadable: string } {
  try {
    if (statSync(path).size > MAX_SECRET_INPUT) return { tooLong: true };
    return { raw: readFileSync(path, 'utf8') };
  } catch (e) {
    return { unreadable: (e as NodeJS.ErrnoException).code ?? 'error' };
  }
}

/** `fornax secrets set <NAME> [--from-file <path>]`: 0 saved, 1 file unreadable, 2 bad name/value/size, 130 canceled. */
export async function secretsSet(ctx: Ctx, name: string, file?: string): Promise<number> {
  const bad = checkSecretName(name);
  if (bad) {
    ctx.out(bad);
    return 2;
  }
  const input = file !== undefined ? fromFile(file) : await (ctx.readSecretInput ?? defaultSecretInput)(`${name}: `);
  if ('unreadable' in input) {
    ctx.out(`${file} cannot be read (${input.unreadable}); nothing was saved`);
    return 1;
  }
  if ('canceled' in input) {
    ctx.out('canceled; nothing was saved');
    return 130;
  }
  if ('tooLong' in input) {
    ctx.out(`the input is larger than ${MAX_SECRET_INPUT / 1024} KiB; nothing was saved`);
    return 2;
  }
  const v = parseSecretValue(input.raw);
  if ('problem' in v) {
    ctx.out(`${v.problem}; nothing was saved`);
    return 2;
  }
  ctx.out(`${name} saved in ${writeSecret(ctx.paths.secretsDir, name, v.value)}`);
  const packs = wanted(ctx).get(name) ?? [];
  if (packs.length) ctx.out(`used by the setup of: ${packs.join(', ')}; run ${packs.map((p) => `fornax types setup ${p}`).join(' and ')} to use it now`);
  else ctx.out(`no installed type pack asks for ${name}`);
  return 0;
}

/** `fornax secrets list`: names only, never values. */
export function secretsList(ctx: Ctx): number {
  const stored = storedSecretNames(ctx.paths.secretsDir);
  const by = wanted(ctx);
  for (const n of stored) ctx.out(by.has(n) ? `${n}  used by: ${by.get(n)!.join(', ')}` : `${n}  not used by any installed pack`);
  for (const n of [...by.keys()].sort()) if (!stored.includes(n)) ctx.out(`${n}  not set (wanted by: ${by.get(n)!.join(', ')})`);
  if (!stored.length && !by.size) ctx.out(`no secrets in ${ctx.paths.secretsDir}`);
  return 0;
}

/** `fornax secrets remove <NAME>`. */
export function secretsRemove(ctx: Ctx, name: string): number {
  const bad = checkSecretName(name);
  if (bad) {
    ctx.out(bad);
    return 2;
  }
  if (!removeSecret(ctx.paths.secretsDir, name)) {
    ctx.out(`${name} is not set`);
    return 0;
  }
  ctx.out(`${name} removed`);
  const packs = wanted(ctx).get(name) ?? [];
  if (packs.length) ctx.out(`the next setup of ${packs.join(', ')} runs without it`);
  return 0;
}
