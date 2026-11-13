import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TYPE_NAME } from '@fornax/protocol';
import { checkPack } from '../checks.js';
import { copyToClipboard } from '../clipboard.js';
import { ConfigError, readWorkerConfig } from '../config.js';
import { loadPack, loadPacks, missingTools } from '../pack.js';
import { childEnv, logTail, runProcess } from '../process.js';
import { buildTypePrompt, gpuSummary, systemSummary } from '../prompt.js';
import { readShippedDoc, shippedExamples, shippedPack } from '../shipped.js';
import { expandArgv } from '../template.js';
import type { Ctx } from './context.js';

/** A pack's setup (venv, packages, models) may take this long. */
export const SETUP_TIMEOUT_MS = 2 * 3_600_000;

/** Tools from worker.yaml, or none before pairing: the types commands work without a server. */
function localTools(ctx: Ctx): Record<string, string> {
  try {
    return readWorkerConfig(ctx.paths).tools;
  } catch (e) {
    if (e instanceof ConfigError) return {};
    throw e;
  }
}

const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/** The first link (symlink or junction) in the pack outside env/, relative to it; null when there is none. */
function findLink(root: string, dir: string = root): string | null {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (relative(root, p).split(sep)[0] === 'env') continue;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return relative(root, p);
    if (st.isDirectory()) {
      const inner = findLink(root, p);
      if (inner) return inner;
    }
  }
  return null;
}

/** `fornax types list`: installed packs and whether each is ready. */
export async function typesList(ctx: Ctx): Promise<number> {
  const tools = localTools(ctx);
  const { packs, errors } = loadPacks(ctx.paths.typesDir);
  if (!packs.length && !errors.length) ctx.out(`no type packs in ${ctx.paths.typesDir}`);
  for (const p of packs) {
    const problem = await checkPack(p, tools, { signal: ctx.signal });
    ctx.out(`${p.contract.name} v${p.contract.version}  ${problem ? `not ready: ${problem}` : 'ready'}`);
  }
  for (const e of errors) ctx.out(e);
  return 0;
}

/** `fornax types install <name> [--from <dir>]`: copy the pack (without env/), run its setup, check it. */
export async function typesInstall(
  ctx: Ctx,
  name: string,
  from?: string,
  /** Tests replace the file operations. */
  deps: { copy?: typeof cpSync; remove?: (dir: string) => void } = {},
): Promise<number> {
  if (!TYPE_NAME.test(name)) {
    ctx.out('a type name is a-z, 0-9 and "-", starting with a letter or digit');
    return 2;
  }
  const source = from !== undefined ? resolve(from) : shippedPack(name);
  if (!source || !existsSync(join(source, 'type.yaml'))) {
    ctx.out(from !== undefined ? `${source} holds no type.yaml` : `there is no built-in type pack ${name}; install one from a directory with --from <dir>`);
    return 1;
  }
  const pack = loadPack(source);
  if (pack.contract.name !== name) {
    ctx.out(`the pack in ${source} is named ${pack.contract.name}, not ${name}`);
    return 1;
  }
  const dest = join(ctx.paths.typesDir, name);
  const types = resolve(ctx.paths.typesDir);
  const rel = (a: string, b: string) => relative(a, b);
  const inside = (outer: string, inner: string) => {
    const r = rel(outer, inner);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  if (inside(source, types) || inside(types, source)) {
    ctx.out(`the pack directory ${source} and the installed types directory ${types} must not contain one another`);
    return 1;
  }
  if (existsSync(dest)) {
    ctx.out(`${name} is already installed in ${dest}; remove that directory to install it again`);
    return 1;
  }
  const tools = localTools(ctx);
  const missing = missingTools(pack, tools);
  if (pack.impl.setup && missing.length) {
    ctx.out(`the setup of ${name} needs these tools in ${ctx.paths.configFile}: ${missing.join(', ')}`);
    return 1;
  }

  const link = findLink(source);
  if (link) {
    ctx.out(`the pack in ${source} holds a link (${link}); links are not copied, replace it with the file itself`);
    return 1;
  }

  mkdirSync(ctx.paths.typesDir, { recursive: true });
  let installed = false;
  let failure: string | null = null;
  try {
    // env/ is made by setup on this PC; a copied one would belong to another machine.
    (deps.copy ?? cpSync)(source, dest, { recursive: true, filter: (src) => relative(source, src).split(sep)[0] !== 'env' });
    if (pack.impl.setup) {
      ctx.out(`running the setup of ${name}…`);
      const r = await runProcess({
        argv: expandArgv(pack.impl.setup, { pack: dest, tools }),
        cwd: dest,
        env: childEnv(process.env, {}),
        timeoutMs: SETUP_TIMEOUT_MS,
        signal: ctx.signal,
        onOutput: ctx.write,
      });
      if (r.code !== 0) {
        const why = r.spawnError ?? (r.timedOut ? 'it ran too long' : r.canceled ? 'interrupted' : `exit code ${r.code ?? r.signal}`);
        const tail = logTail(r.log);
        failure = `the setup of ${name} failed (${why})${tail ? `: ${tail}` : ''}`;
      }
    }
    installed = failure === null;
  } catch (e) {
    // Only the class and code: the message may carry local paths or tool output.
    const code = (e as NodeJS.ErrnoException).code;
    failure = `installing ${name} failed (${e instanceof Error ? e.constructor.name : typeof e}${typeof code === 'string' ? `, ${code}` : ''})`;
  } finally {
    if (!installed) {
      if (failure) ctx.out(failure);
      try {
        (deps.remove ?? removeDir)(dest);
        ctx.out('nothing was installed');
      } catch {
        ctx.out(`${dest} could not be removed (a file in it is probably still in use); delete that directory by hand before installing again`);
      }
    }
  }
  if (!installed) return 1;
  const problem = await checkPack(loadPack(dest), tools, { signal: ctx.signal });
  ctx.out(problem ? `installed ${name} in ${dest}, but it is not ready: ${problem}` : `installed ${name} in ${dest}; it is ready`);
  ctx.out('a running worker picks it up between jobs');
  return problem ? 1 : 0;
}

function skeletonYaml(name: string): string {
  return [
    '# A new Fornax type pack. The format is described in types/README.md of the Fornax repository.',
    '# Until `run` holds a command, the worker does not offer this type.',
    `name: ${name}`,
    'version: 1',
    'description: Say in one sentence what this job type does.',
    'inputs: {}',
    'params:',
    '  type: object',
    '  additionalProperties: false',
    '  properties: {}',
    'max_runtime: 1h',
    'tools: []',
    '# setup: ["{tool.python}", "{pack}/scripts/setup.py"]   (and list python under tools)',
    '# check: ["{python}", "{pack}/scripts/check.py"]',
    'run: []',
    '',
  ].join('\n');
}

const skeletonSetup = (name: string) =>
  `# ${name}\n\nWhat this type needs and how it is installed, for people and for Claude.\nEverything goes into env/ inside this directory; nothing outside it changes.\n`;

/** `fornax types add <name>`: an empty pack plus the prompt for Claude (spec 7.3), copied to the clipboard and printed. */
export async function typesAdd(ctx: Ctx, name: string): Promise<number> {
  if (!TYPE_NAME.test(name)) {
    ctx.out('a type name is a-z, 0-9 and "-", starting with a letter or digit');
    return 2;
  }
  const dir = join(ctx.paths.typesDir, name);
  if (existsSync(dir)) {
    ctx.out(`${dir} already exists`);
    return 1;
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'type.yaml'), skeletonYaml(name));
  writeFileSync(join(dir, 'setup.md'), skeletonSetup(name));
  const prompt = buildTypePrompt({ name, packDir: dir, system: systemSummary(), gpu: gpuSummary(), formatDoc: readShippedDoc(), examples: shippedExamples() });
  const via = (ctx.clipboard ?? copyToClipboard)(prompt);
  ctx.out(prompt);
  ctx.out('');
  ctx.out(via ? `The prompt above is also in the clipboard (${via}); paste it into Claude Code.` : 'No clipboard program was found; copy the prompt above into Claude Code.');
  return 0;
}
