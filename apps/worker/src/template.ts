import { posix, win32 } from 'node:path';

/** A `{…}` placeholder of type.yaml (spec 6.3). */
export type TemplateSymbol =
  | { kind: 'params'; name: string }
  | { kind: 'input'; name: string }
  | { kind: 'tool'; name: string }
  | { kind: 'params_json' }
  | { kind: 'out' }
  | { kind: 'work' }
  | { kind: 'pack' }
  | { kind: 'python' }
  | { kind: 'node' };

export class TemplateError extends Error {}

/** Every `{…}` is a symbol; there is no escape for literal braces. */
const ANY = /\{([^{}]*)\}/g;
const NAMED = /^(params|input|tool)\.([a-z][a-z0-9_]{0,39})$/;
const PLAIN = ['params_json', 'out', 'work', 'pack', 'python', 'node'] as const;

function parseSymbol(text: string): TemplateSymbol {
  const m = NAMED.exec(text);
  if (m) return { kind: m[1] as 'params' | 'input' | 'tool', name: m[2]! };
  const plain = PLAIN.find((p) => p === text);
  if (plain) return { kind: plain };
  throw new TemplateError(`unknown symbol {${text}}`);
}

export const symbolText = (s: TemplateSymbol): string => ('name' in s ? `${s.kind}.${s.name}` : s.kind);

export function symbolsOf(element: string): TemplateSymbol[] {
  return [...element.matchAll(ANY)].map((m) => parseSymbol(m[1]!));
}

/** The symbol when it is the whole element (`{params.frames}`), else null. */
export function wholeSymbol(element: string): TemplateSymbol | null {
  const m = /^\{([^{}]*)\}$/.exec(element);
  return m ? parseSymbol(m[1]!) : null;
}

/** {python}: the pack's own venv. */
export function pythonPath(pack: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.join(pack, 'env', 'Scripts', 'python.exe') : posix.join(pack, 'env', 'bin', 'python');
}

export type JobContext = {
  /** Validated params with defaults filled in. */
  params: Record<string, unknown>;
  paramsJson: string;
  /** Input name → absolute path of the downloaded file (only inputs that were given). */
  inputs: Record<string, string>;
  out: string;
  work: string;
};

/** `job` is present only for `run`; `setup` and `check` have no job. */
export type ExpandContext = {
  pack: string;
  tools: Record<string, string>;
  job?: JobContext;
  platform?: NodeJS.Platform;
  /** {node}: the Node the worker runs on (process.execPath); tests pass a fixed path. */
  node?: string;
};

function text(v: unknown, what: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new TemplateError(`{${what}} has no value`);
}

function valueOf(s: TemplateSymbol, ctx: ExpandContext): string | string[] {
  const job = (): JobContext => {
    if (!ctx.job) throw new TemplateError(`{${symbolText(s)}} is only available in run`);
    return ctx.job;
  };
  switch (s.kind) {
    case 'pack':
      return ctx.pack;
    case 'python':
      return pythonPath(ctx.pack, ctx.platform);
    case 'node':
      return ctx.node ?? process.execPath;
    case 'tool':
      if (!Object.hasOwn(ctx.tools, s.name)) throw new TemplateError(`tool ${s.name} has no path in worker.yaml`);
      return ctx.tools[s.name]!;
    case 'params_json':
      return job().paramsJson;
    case 'out':
      return job().out;
    case 'work':
      return job().work;
    case 'input': {
      // An optional input that was not given: an empty argument, which the tool reads as "none".
      const j = job();
      return Object.hasOwn(j.inputs, s.name) ? j.inputs[s.name]! : '';
    }
    case 'params': {
      const j = job();
      const v = Object.hasOwn(j.params, s.name) ? j.params[s.name] : undefined;
      return Array.isArray(v) ? v.map((x) => text(x, symbolText(s))) : text(v, symbolText(s));
    }
  }
}

/** Each template element becomes exactly one argument, except a list param that is a whole element. */
export function expandArgv(template: string[], ctx: ExpandContext): string[] {
  const argv: string[] = [];
  for (const element of template) {
    const whole = wholeSymbol(element);
    if (whole) {
      const v = valueOf(whole, ctx);
      argv.push(...(Array.isArray(v) ? v : [v]));
      continue;
    }
    // A replacer function: "$&" and friends in a value stay literal.
    argv.push(
      element.replace(ANY, (_match, inner: string) => {
        const s = parseSymbol(inner);
        const v = valueOf(s, ctx);
        if (Array.isArray(v)) throw new TemplateError(`the list {${symbolText(s)}} must be a whole argument`);
        return v;
      }),
    );
  }
  return argv;
}
