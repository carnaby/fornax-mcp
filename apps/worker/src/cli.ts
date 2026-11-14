#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FORNAX_VERSION } from '@fornax/protocol';
import { ApiError, NetworkError } from './api.js';
import type { Ctx } from './commands/context.js';
import { doctor } from './commands/doctor.js';
import { pair } from './commands/pair.js';
import { typesAdd, typesInstall, typesList } from './commands/types.js';
import { queueCommand, workerCommand } from './commands/worker.js';
import { ConfigError } from './config.js';
import { PackError } from './pack.js';
import { resolvePaths } from './paths.js';
import { hasRunning, killRunning } from './process.js';

export const USAGE = [
  'usage: fornax worker pair --server <url> --name <name> [--force]',
  '       fornax worker [--once]',
  '       fornax worker queue',
  '       fornax doctor [type]',
  '       fornax types list',
  '       fornax types install <name> [--from <dir>]',
  '       fornax types add <name>',
  '       fornax --version',
].join('\n');

type Flags = { server?: string; name?: string; force?: boolean; from?: string; once?: boolean; help?: boolean; version?: boolean };

/** Parse and dispatch. 0 done, 1 failed (the message says why), 2 usage. */
export async function runCli(argv: string[], ctx: Ctx): Promise<number> {
  let flags: Flags;
  let words: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        server: { type: 'string' },
        name: { type: 'string' },
        force: { type: 'boolean' },
        from: { type: 'string' },
        once: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    flags = parsed.values;
    words = parsed.positionals;
  } catch (e) {
    ctx.out((e as Error).message);
    ctx.out(USAGE);
    return 2;
  }
  if (flags.version) {
    ctx.out(FORNAX_VERSION);
    return 0;
  }
  if (flags.help) {
    ctx.out(USAGE);
    return 0;
  }
  /** Exactly `n` words, and no flag the command does not take (a typo must not silently change the meaning). */
  const shape = (n: number, ...allowed: (keyof Flags)[]) => words.length === n && Object.keys(flags).every((k) => allowed.includes(k as keyof Flags));
  const [group, sub, arg] = words;
  try {
    if (group === 'worker' && sub === 'pair' && shape(2, 'server', 'name', 'force') && flags.server && flags.name) {
      return await pair(ctx, { server: flags.server, name: flags.name, force: flags.force === true });
    }
    if (group === 'worker' && sub === undefined && shape(1, 'once')) return await workerCommand(ctx, flags.once === true);
    if (group === 'worker' && sub === 'queue' && shape(2)) return await queueCommand(ctx);
    if (group === 'doctor' && (shape(1) || shape(2))) return await doctor(ctx, sub);
    if (group === 'types' && sub === 'list' && shape(2)) return await typesList(ctx);
    if (group === 'types' && sub === 'install' && arg !== undefined && shape(3, 'from')) return await typesInstall(ctx, arg, flags.from);
    if (group === 'types' && sub === 'add' && arg !== undefined && shape(3)) return await typesAdd(ctx, arg);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof PackError || e instanceof NetworkError || e instanceof ApiError) {
      ctx.out(e.message);
      return 1;
    }
    // Anything else may carry local paths or tool output in its message: only its class and code are shown.
    const code = (e as NodeJS.ErrnoException).code;
    ctx.out(`unexpected error: ${e instanceof Error ? e.constructor.name : typeof e}${typeof code === 'string' ? ` (${code})` : ''}`);
    return 1;
  }
  ctx.out(USAGE);
  return 2;
}

type SignalDeps = {
  abort: () => void;
  killRunning: () => Promise<void>;
  hasRunning: () => boolean;
  exit: (code: number) => void;
  say: (text: string) => void;
};

/** First signal: stop gracefully. Second: kill the running tool tree, then exit 130 (a hard quit must not orphan the tool). Later ones are ignored. */
export function makeSignalHandler(d: SignalDeps): () => void {
  let signals = 0;
  return () => {
    if (++signals === 1) {
      d.say(
        d.hasRunning()
          ? 'stopping: the running job is stopped and given back (Ctrl+C again quits at once)'
          : 'stopping (Ctrl+C again quits at once)',
      );
      d.abort();
    } else if (signals === 2) {
      void d.killRunning().finally(() => d.exit(130));
    }
  };
}

/**
 * Write errors that only mean nobody reads the console any more: EIO once the terminal or SSH session hung up (Linux),
 * EPIPE once the reading end of a pipe closed; later writes to the then destroyed stream report ERR_STREAM_DESTROYED.
 */
const CONSOLE_GONE = new Set(['EIO', 'EPIPE', 'ERR_STREAM_DESTROYED']);
const guarded = new WeakSet<NodeJS.WritableStream>();

/**
 * A writer for a console stream that a lost console cannot crash. Such a write error comes as a stream 'error' event
 * after the write call returned; without a listener it would end the worker before the running job is given back.
 * Any other error still surfaces.
 */
export function consoleWriter(stream: NodeJS.WritableStream): (text: string) => void {
  if (!guarded.has(stream)) {
    guarded.add(stream);
    stream.on('error', (e: NodeJS.ErrnoException) => {
      if (!CONSOLE_GONE.has(e.code ?? '')) throw e;
    });
  }
  return (text) => {
    try {
      stream.write(text);
    } catch (e) {
      if (!CONSOLE_GONE.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
    }
  };
}

/** The signals that stop the worker. SIGHUP: the terminal or SSH session closed (Linux), the console window closed (Windows). */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Wire `handler` to every stop signal; returns the unwiring. */
export function wireSignals(target: Pick<NodeJS.EventEmitter, 'on' | 'off'>, handler: () => void): () => void {
  for (const s of STOP_SIGNALS) target.on(s, handler);
  return () => {
    for (const s of STOP_SIGNALS) target.off(s, handler);
  };
}

/** Both sides resolved the way the OS names the file (drive letter case, links); false when argv[1] is no file. */
function isMainModule(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const stop = new AbortController();
  // Every line the worker prints goes through these: a hung-up terminal must not crash it (see consoleWriter).
  const out = consoleWriter(process.stdout);
  const err = consoleWriter(process.stderr);
  const onSignal = makeSignalHandler({
    abort: () => stop.abort(),
    killRunning: () => killRunning(2000),
    hasRunning,
    exit: (c) => process.exit(c),
    say: (t) => err(`${t}\n`),
  });
  const unwire = wireSignals(process, onSignal);
  const ctx: Ctx = { paths: resolvePaths(), out: (l) => out(`${l}\n`), write: out, signal: stop.signal };
  process.exitCode = await runCli(process.argv.slice(2), ctx);
  unwire();
}
