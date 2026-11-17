import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isWindowsReservedName, type JobTypeContract, jobTypeContract, type ParamProperty, PRIORITIES } from '@fornax/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { TOOL_NAME } from './config.js';
import { symbolsOf, symbolText, type TemplateSymbol, wholeSymbol } from './template.js';

/** The part of a type pack that never leaves this PC: what to install, check and run. */
export type PackImpl = { tools: string[]; setup?: string[]; check?: string[]; run: string[] };
export type Pack = { contract: JobTypeContract; impl: PackImpl; dir: string };

/** A type pack that cannot be used, and why (spec 06c 2.2 reports it per type). */
export type PackProblem = { name: string; reason: string };

/** A pack cannot be used; the message names the pack and the problem, `reason` is the problem alone. */
export class PackError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string = message) {
    super(message);
    this.reason = reason;
  }
}

const argv = z
  .array(z.string().max(4000))
  .min(1)
  .max(200)
  .refine((a) => a[0] !== '', { error: 'the first element is the program and cannot be empty' });

const typeYaml = z.strictObject({
  name: z.string(),
  version: z.number(),
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()).nullish(),
  params: z.unknown(),
  max_runtime: z.string(),
  /** Spec 07 § 4.4: the priority of a job submitted without one. */
  default_priority: z.enum(PRIORITIES).optional(),
  tools: z.array(z.string().regex(TOOL_NAME, 'tool names are a-z, 0-9 and "_", starting with a letter')).max(20).nullish(),
  setup: argv.optional(),
  check: argv.optional(),
  run: argv,
});

const UNITS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

/** "30s", "10m", "6h", "2d" → seconds; null when the text is not such a duration. */
export function parseDuration(raw: string): number | null {
  const m = /^([1-9][0-9]{0,6})([smhd])$/.exec(raw.trim());
  return m ? Number(m[1]) * UNITS[m[2] as keyof typeof UNITS] : null;
}

type Where = 'setup' | 'check' | 'run';

/** A number that could be negative reads as an option ("-1") when it is a whole argument. */
function mayBeNegative(p: ParamProperty): boolean {
  const q = 'items' in p ? p.items : p;
  if (!('type' in q)) return q.enum.some((v) => typeof v === 'number' && v < 0);
  return (q.type === 'integer' || q.type === 'number') && (q.minimum === undefined || q.minimum < 0);
}

function paramProblem(name: string, whole: boolean, contract: JobTypeContract, text: string): string | null {
  const { properties, required } = contract.params;
  const prop = Object.hasOwn(properties, name) ? properties[name] : undefined;
  if (!prop) return `${text}: there is no parameter ${name}`;
  if (prop.default === undefined && !required?.includes(name)) {
    return `${text}: an optional parameter without a default reaches the tool only through {params_json}`;
  }
  if ('type' in prop && prop.type === 'array' && !whole) return `${text}: a list must be a whole argument`;
  if (whole && mayBeNegative(prop)) {
    return `${text}: a number that may be negative cannot be a whole argument ("-1" would read as an option); set minimum: 0, or embed it as in --x=${text}`;
  }
  return null;
}

function symbolProblem(s: TemplateSymbol, whole: boolean, where: Where, impl: PackImpl, contract: JobTypeContract): string | null {
  const text = `{${symbolText(s)}}`;
  const onlyRun = where === 'run' ? null : `${text} is only available in run`;
  switch (s.kind) {
    case 'pack':
    case 'python':
    case 'node':
      return null;
    case 'tool':
      return impl.tools.includes(s.name) ? null : `${text}: ${s.name} is not listed in tools`;
    case 'params_json':
    case 'out':
    case 'work':
      return onlyRun;
    case 'input':
      return onlyRun ?? (Object.hasOwn(contract.inputs, s.name) ? null : `${text}: there is no input ${s.name}`);
    case 'params':
      return onlyRun ?? paramProblem(s.name, whole, contract, text);
  }
}

function elementProblem(element: string, where: Where, impl: PackImpl, contract: JobTypeContract): string | null {
  let symbols: TemplateSymbol[];
  try {
    symbols = symbolsOf(element);
  } catch (e) {
    return (e as Error).message;
  }
  if (/[{}]/.test(element.replace(/{[^{}]*}/g, ''))) return `unbalanced brace: ${element}`;
  const whole = wholeSymbol(element) !== null;
  for (const s of symbols) {
    const p = symbolProblem(s, whole, where, impl, contract);
    if (p) return p;
  }
  return null;
}

/** Load one pack directory and apply the load-time rules of spec 6.2 and 6.3. */
export function loadPack(dir: string): Pack {
  const label = basename(dir);
  const problem = (msg: string) => new PackError(`type pack ${label}: ${msg}`, msg);
  const file = join(dir, 'type.yaml');
  if (!existsSync(file)) throw problem('type.yaml is missing');
  let text: string;
  let raw: unknown;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw problem(`type.yaml cannot be read: ${(e as Error).message}`);
  }
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw problem(`type.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const y = typeYaml.safeParse(raw);
  if (!y.success) throw problem(z.prettifyError(y.error));
  const seconds = parseDuration(y.data.max_runtime);
  if (seconds === null) throw problem('max_runtime must look like 30s, 10m, 6h or 2d');
  const c = jobTypeContract.safeParse({
    name: y.data.name,
    version: y.data.version,
    description: y.data.description,
    inputs: y.data.inputs ?? {},
    params: y.data.params,
    max_runtime_s: seconds,
    // Absent stays absent: the contract hash of a pack without it does not change.
    ...(y.data.default_priority ? { default_priority: y.data.default_priority } : {}),
  });
  if (!c.success) throw problem(z.prettifyError(c.error));
  const contract = c.data;
  for (const input of Object.keys(contract.inputs)) {
    // The input arrives as in/<name><ext>; Windows cannot create a file named like a device.
    if (isWindowsReservedName(input)) throw problem(`input name ${input} is reserved on Windows`);
  }
  const impl: PackImpl = {
    tools: y.data.tools ?? [],
    run: y.data.run,
    ...(y.data.setup ? { setup: y.data.setup } : {}),
    ...(y.data.check ? { check: y.data.check } : {}),
  };
  for (const [where, list] of [['setup', impl.setup], ['check', impl.check], ['run', impl.run]] as const) {
    for (const element of list ?? []) {
      const p = elementProblem(element, where, impl, contract);
      if (p) throw problem(`${where}: ${p}`);
    }
  }
  return { contract, impl, dir };
}

/** Every pack under <data>/types. A broken pack is reported, not fatal. A pack's name must match its directory. */
export function loadPacks(typesDir: string): { packs: Pack[]; errors: string[]; failed: PackProblem[] } {
  const packs: Pack[] = [];
  const errors: string[] = [];
  const failed: PackProblem[] = [];
  if (!existsSync(typesDir)) return { packs, errors, failed };
  const names = readdirSync(typesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of names) {
    try {
      const pack = loadPack(join(typesDir, name));
      if (pack.contract.name !== name) {
        const reason = `its name is ${pack.contract.name}; the directory must have the same name`;
        throw new PackError(`type pack ${name}: ${reason}`, reason);
      }
      packs.push(pack);
    } catch (e) {
      if (!(e instanceof PackError)) throw e;
      errors.push(e.message);
      failed.push({ name, reason: e.reason });
    }
  }
  return { packs, errors, failed };
}

/** Tools the pack lists that worker.yaml does not give a path for. */
export const missingTools = (pack: Pack, tools: Record<string, string>): string[] => pack.impl.tools.filter((t) => !Object.hasOwn(tools, t));
