#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FORNAX_VERSION } from '@fornax/protocol';
import { ApiError, NetworkError } from './api.js';
import type { Ctx } from './commands/context.js';
import { doctor } from './commands/doctor.js';
import { LEASE_FORMS, leaseCommand, usageText } from './commands/lease.js';
import { pair } from './commands/pair.js';
import { typesAdd, typesInstall, typesList } from './commands/types.js';
import { queueCommand, workerCommand } from './commands/worker.js';
import { ConfigError } from './config.js';
import { PackError } from './pack.js';
import { resolvePaths } from './paths.js';
import { hasRunning, killRunning } from './process.js';

export const USAGE = usageText([
  'fornax worker pair --server <url> --name <name> [--force]',
  'fornax worker [--once]',
  'fornax worker queue',
  'fornax doctor [type]',
  'fornax types list',
  'fornax types install <name> [--from <dir>]',
  'fornax types add <name>',
  ...LEASE_FORMS,
  'fornax --version',
]);

type Flags = { server?: string; name?: string; force?: boolean; from?: string; once?: boolean; help?: boolean; version?: boolean };

/** How a command's error ends: our own errors with their message, anything else only with its class (it may hold paths or tool output). */
export function reportError(e: unknown, say: (line: string) => void): number {
  if (e instanceof ConfigError || e instanceof PackError || e instanceof NetworkError || e instanceof ApiError) {
    say(e.message);
    return 1;
  }
  const code = (e as NodeJS.ErrnoException).code;
  say(`unexpected error: ${e instanceof Error ? e.constructor.name : typeof e}${typeof code === 'string' ? ` (${code})` : ''}`);
  return 1;
}

/** Parse and dispatch. 0 done, 1 failed (the message says why), 2 usage; fornax lease has exit codes of its own. */
export async function runCli(argv: string[], ctx: Ctx): Promise<number> {
  // fornax lease has options of its own (its usage errors are 120) and hands everything after -- to the program untouched.
  if (argv[0] === 'lease') {
    try {
      return await leaseCommand(argv.slice(1), ctx);
    } catch (e) {
      return reportError(e, ctx.err ?? ctx.out);
    }
  }
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
    return reportError(e, ctx.out);
  }
  ctx.out(USAGE);
  return 2;
}

type SignalDeps = {
  /** The signal's name becomes the stop's reason: fornax lease passes it on to its program. */
  abort: (signal?: NodeJS.Signals) => void;
  killRunning: () => Promise<void>;
  hasRunning: () => boolean;
  exit: (code: number) => void;
  say: (text: string) => void;
  /**
   * fornax lease: with no program running, the second signal does not quit at once but gives the first one's cancel of
   * the waiting job this long (the command then ends by itself), and exits 130 only after it. Unset: quit at once.
   */
  cancelGraceMs?: number;
};

/** The longest a second Ctrl+C of fornax lease waits for the cancel of a waiting job. */
export const LEASE_CANCEL_GRACE_MS = 3000;

/**
 * First signal: stop gracefully. Second: kill the running tool tree, then exit 130 (a hard quit must not orphan the
 * tool); for fornax lease with no program running, wait (bounded) for the cancel of its job first. Later ones are ignored.
 */
export function makeSignalHandler(d: SignalDeps): (signal?: NodeJS.Signals) => void {
  let signals = 0;
  return (signal) => {
    if (++signals === 1) {
      d.say(
        d.hasRunning()
          ? 'stopping: the running job is stopped and given back (Ctrl+C again quits at once)'
          : 'stopping (Ctrl+C again quits at once)',
      );
      d.abort(signal);
    } else if (signals === 2) {
      if (d.cancelGraceMs !== undefined && !d.hasRunning()) {
        // Quitting now would leave the lease job queued (once claimed it would block the card for a minute). Unref'd:
        // when the command ends by itself sooner, the process ends with it.
        setTimeout(() => d.exit(130), d.cancelGraceMs).unref();
        return;
      }
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
/**
 * fornax lease also stops on SIGQUIT (Ctrl+\ on Linux): its program runs in a session of its own, which the terminal's
 * signals do not reach, so without this the wrapper would end and leave the program on the card.
 */
export const LEASE_STOP_SIGNALS = [...STOP_SIGNALS, 'SIGQUIT'] as const;

/** Wire `handler` to every signal of `signals` (Node calls it with the signal's name); returns the unwiring. */
export function wireSignals(
  target: Pick<NodeJS.EventEmitter, 'on' | 'off'>,
  handler: (signal?: NodeJS.Signals) => void,
  signals: readonly NodeJS.Signals[] = STOP_SIGNALS,
): () => void {
  for (const s of signals) target.on(s, handler);
  return () => {
    for (const s of signals) target.off(s, handler);
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
  // fornax lease says itself what a stop does (it cancels the job or stops its program). SIGHUP and SIGQUIT stop it as
  // SIGTERM does: on Linux the program runs in a session of its own, so a closed terminal or Ctrl+\ reaches the program
  // only this way (the signal itself is passed on).
  const leasing = process.argv[2] === 'lease' && process.argv[3] !== 'token';
  const onSignal = makeSignalHandler({
    abort: (signal) => stop.abort(signal),
    killRunning: () => killRunning(2000),
    hasRunning,
    exit: (c) => process.exit(c),
    say: leasing ? () => {} : (t) => err(`${t}\n`),
    cancelGraceMs: leasing ? LEASE_CANCEL_GRACE_MS : undefined,
  });
  const unwire = wireSignals(process, onSignal, leasing ? LEASE_STOP_SIGNALS : STOP_SIGNALS);
  const ctx: Ctx = { paths: resolvePaths(), out: (l) => out(`${l}\n`), err: (l) => err(`${l}\n`), write: out, signal: stop.signal };
  process.exitCode = await runCli(process.argv.slice(2), ctx);
  unwire();
}
