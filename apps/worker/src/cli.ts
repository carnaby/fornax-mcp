#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FORNAX_VERSION, type MoveTarget, priorityInput } from '@fornax/protocol';
import { ApiError, NetworkError } from './api.js';
import type { Ctx } from './commands/context.js';
import { doctor } from './commands/doctor.js';
import { installCommand } from './commands/install.js';
import { LEASE_FORMS, leaseCommand, usageText } from './commands/lease.js';
import { pair } from './commands/pair.js';
import { queueCancel, queueMove, queuePause, queuePriority, queueRequeue, queueShow, queueStartIdle, queueWatch } from './commands/queue.js';
import { secretsList, secretsRemove, secretsSet, VALUE_AS_ARGUMENT } from './commands/secrets.js';
import { trayInstallCommand } from './commands/tray.js';
import { typesAdd, typesInstall, typesList, typesSetup } from './commands/types.js';
import { updateCommand } from './commands/update.js';
import { queueCommand, workerCommand } from './commands/worker.js';
import { ConfigError } from './config.js';
import { eventLine, onInputEnd, readStops, type WorkerEvent } from './events.js';
import { InstallError } from './install/errors.js';
import type { TypeState } from './loop.js';
import { PackError } from './pack.js';
import { resolvePaths } from './paths.js';
import { hasRunning, killRunning } from './process.js';
import { superviseWorker, watchParent } from './supervisor.js';

export const USAGE = usageText([
  'fornax worker pair --server <url> --name <name> [--force]',
  'fornax worker [--once] [--events]',
  'fornax worker queue',
  'fornax queue [--json] [--watch]',
  'fornax queue move <id> (--top | --bottom | --before <id> | --after <id>)',
  'fornax queue cancel <id>',
  'fornax queue pause | resume [--json]',
  'fornax queue priority <id> high|normal|idle [--json]',
  'fornax queue requeue <id> [--idle] [--json]',
  'fornax queue start-idle [--json]',
  'fornax doctor [type]',
  'fornax types list',
  'fornax types install <name> [--from <dir>]',
  'fornax types add <name>',
  'fornax types setup <name>',
  'fornax secrets set <NAME> [--from-file <path>]',
  'fornax secrets list',
  'fornax secrets remove <NAME>',
  'fornax install',
  'fornax update [--force] [--server <url>]',
  'fornax tray install',
  ...LEASE_FORMS,
  'fornax --version',
]);

type Flags = {
  server?: string;
  name?: string;
  force?: boolean;
  from?: string;
  'from-file'?: string;
  once?: boolean;
  child?: boolean;
  help?: boolean;
  version?: boolean;
  json?: boolean;
  watch?: boolean;
  top?: boolean;
  bottom?: boolean;
  before?: string;
  after?: string;
  idle?: boolean;
  events?: boolean;
  'wait-pid'?: string;
  relaunch?: string;
};

/** How a command's error ends: our own errors with their message, anything else only with its class (it may hold paths or tool output). */
export function reportError(e: unknown, say: (line: string) => void): number {
  if (e instanceof ConfigError || e instanceof PackError || e instanceof NetworkError || e instanceof ApiError || e instanceof InstallError) {
    say(e.message);
    return 1;
  }
  const code = (e as NodeJS.ErrnoException).code;
  say(`unexpected error: ${e instanceof Error ? e.constructor.name : typeof e}${typeof code === 'string' ? ` (${code})` : ''}`);
  return 1;
}

/** Exactly one of --top, --bottom, --before <id>, --after <id>; null otherwise (a usage error). */
function moveTargetOf(flags: Flags): MoveTarget | null {
  const given: MoveTarget[] = [];
  if (flags.top) given.push({ to: 'top' });
  if (flags.bottom) given.push({ to: 'bottom' });
  if (flags.before !== undefined) given.push({ before: flags.before });
  if (flags.after !== undefined) given.push({ after: flags.after });
  return given.length === 1 ? given[0]! : null;
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
        'from-file': { type: 'string' },
        once: { type: 'boolean' },
        child: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        watch: { type: 'boolean' },
        top: { type: 'boolean' },
        bottom: { type: 'boolean' },
        before: { type: 'string' },
        after: { type: 'string' },
        idle: { type: 'boolean' },
        events: { type: 'boolean' },
        'wait-pid': { type: 'string' },
        relaunch: { type: 'string' },
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
  const [group, sub, arg, arg2] = words;
  if (group === 'queue') {
    try {
      if (sub === undefined && shape(1, 'json', 'watch')) {
        return flags.watch ? await queueWatch(ctx, { json: flags.json === true }) : await queueShow(ctx, { json: flags.json === true });
      }
      const target = moveTargetOf(flags);
      if (sub === 'move' && arg !== undefined && target && shape(3, 'top', 'bottom', 'before', 'after')) return await queueMove(ctx, arg, target);
      if (sub === 'cancel' && arg !== undefined && shape(3)) return await queueCancel(ctx, arg);
      if ((sub === 'pause' || sub === 'resume') && shape(2, 'json')) return await queuePause(ctx, sub === 'pause', { json: flags.json === true });
      // Spec 07 § 4.3; an unknown priority falls through to the usage.
      const priority = sub === 'priority' && arg2 !== undefined ? priorityInput.safeParse(arg2) : null;
      if (priority?.success && arg !== undefined && shape(4, 'json')) return await queuePriority(ctx, arg, priority.data, { json: flags.json === true });
      if (sub === 'requeue' && arg !== undefined && shape(3, 'idle', 'json')) return await queueRequeue(ctx, arg, { idle: flags.idle === true, json: flags.json === true });
      if (sub === 'start-idle' && shape(2, 'json')) return await queueStartIdle(ctx, { json: flags.json === true });
    } catch (e) {
      return reportError(e, ctx.err ?? ctx.out);
    }
    ctx.out(USAGE);
    return 2;
  }
  try {
    if (group === 'install' && shape(1)) return await installCommand(ctx);
    if (group === 'update' && shape(1, 'force', 'server')) return await updateCommand(ctx, { force: flags.force === true, server: flags.server });
    // --wait-pid and --relaunch are the tray's (spec 06d 4.3): wait for the old tray, start the new one afterwards.
    if (group === 'tray' && sub === 'install' && shape(2, 'wait-pid', 'relaunch')) {
      const raw = flags['wait-pid'];
      const waitPid = raw === undefined ? undefined : /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
      if (waitPid !== null) return await trayInstallCommand(ctx, { waitPid, relaunch: flags.relaunch });
    }
    if (group === 'worker' && sub === 'pair' && shape(2, 'server', 'name', 'force') && flags.server && flags.name) {
      return await pair(ctx, { server: flags.server, name: flags.name, force: flags.force === true });
    }
    // `worker --child` and its restart exit code 75 are a contract across versions: a supervisor that is still running
    // an older version starts the newly installed program this way after fornax update. Not in USAGE: internal.
    if (group === 'worker' && sub === undefined && shape(1, 'once', 'child', 'events')) {
      if (!flags.child && ctx.supervise) return await ctx.supervise([...(flags.once ? ['--once'] : []), ...(flags.events ? ['--events'] : [])]);
      return await workerCommand(ctx, flags.once === true, { child: flags.child === true });
    }
    if (group === 'worker' && sub === 'queue' && shape(2)) return await queueCommand(ctx);
    if (group === 'doctor' && (shape(1) || shape(2))) return await doctor(ctx, sub);
    if (group === 'types' && sub === 'list' && shape(2)) return await typesList(ctx);
    if (group === 'types' && sub === 'install' && arg !== undefined && shape(3, 'from')) return await typesInstall(ctx, arg, flags.from);
    if (group === 'types' && sub === 'add' && arg !== undefined && shape(3)) return await typesAdd(ctx, arg);
    if (group === 'types' && sub === 'setup' && arg !== undefined && shape(3)) return await typesSetup(ctx, arg);
    // Spec 08 § 3: the value never comes from an argument; a fourth word is a usage error that never echoes it.
    if (group === 'secrets' && sub === 'set' && arg !== undefined && shape(3, 'from-file')) return await secretsSet(ctx, arg, flags['from-file']);
    if (group === 'secrets' && sub === 'list' && shape(2)) return secretsList(ctx);
    if (group === 'secrets' && sub === 'remove' && arg !== undefined && shape(3)) return secretsRemove(ctx, arg);
    // Final review #7: a value given as an argument gets its own reason, never an echo.
    if (group === 'secrets' && sub === 'set' && words.length > 3) {
      ctx.out(VALUE_AS_ARGUMENT);
      return 2;
    }
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
  /** What the first message says quits at once, in its parentheses (default: Ctrl+C again; under the tray: TRAY_SECOND_STOP). */
  secondStopHint?: string;
};

/** Spec 06 3.2: under the tray a stop comes as a line from it, not as Ctrl+C. */
export const TRAY_SECOND_STOP = 'a second stop quits at once';

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
      const hint = d.secondStopHint ?? 'Ctrl+C again quits at once';
      d.say(d.hasRunning() ? `stopping: the running job is stopped and given back (${hint})` : `stopping (${hint})`);
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
  const argv = process.argv.slice(2);
  // Every line the worker prints goes through these: a hung-up terminal must not crash it (see consoleWriter).
  const stdout = consoleWriter(process.stdout);
  const stderr = consoleWriter(process.stderr);
  // Spec 06 3.2: under the tray (`fornax worker --events`) stdout carries JSON lines only and stdin carries "stop".
  const events = argv[0] === 'worker' && argv.includes('--events');
  const isChild = argv[0] === 'worker' && argv.includes('--child');
  const emit = (e: WorkerEvent) => stdout(eventLine(e));
  const asLog = (line: string) => emit({ event: 'log', line });
  const out = events ? asLog : (line: string) => stdout(`${line}\n`);
  const err = events ? asLog : (line: string) => stderr(`${line}\n`);
  // fornax lease says itself what a stop does (it cancels the job or stops its program). SIGHUP and SIGQUIT stop it as
  // SIGTERM does: on Linux the program runs in a session of its own, so a closed terminal or Ctrl+\ reaches the program
  // only this way (the signal itself is passed on).
  const leasing = argv[0] === 'lease' && argv[1] !== 'token';
  const onSignal = makeSignalHandler({
    abort: (signal) => stop.abort(signal),
    killRunning: () => killRunning(2000),
    hasRunning,
    exit: (c) => process.exit(c),
    say: leasing ? () => {} : err,
    cancelGraceMs: leasing ? LEASE_CANCEL_GRACE_MS : undefined,
    secondStopHint: events ? TRAY_SECOND_STOP : undefined,
  });
  let unwire = wireSignals(process, onSignal, leasing ? LEASE_STOP_SIGNALS : STOP_SIGNALS);
  // The child under the tray takes "stop" lines as the signals (first graceful, second at once); the end of stdin (the
  // supervisor gone) is one stop. Not a second one: after a stop by signal (Linux: passed on by the supervisor, which
  // was then killed) the end of stdin must not become the hard quit (like watchParent below).
  const unreadStops =
    events && isChild
      ? readStops(
          process.stdin,
          () => onSignal('SIGTERM'),
          () => {
            if (!stop.signal.aborted) onSignal('SIGTERM');
          },
        )
      : () => {};
  // Spec 06 3.1: `fornax queue --json --watch` (the tray's reader) ends when stdin closes, i.e. when the tray is gone.
  const unwatchInput =
    argv[0] === 'queue' && argv.includes('--watch') && argv.includes('--json') ? onInputEnd(process.stdin, () => stop.abort()) : () => {};
  const ctx: Ctx = {
    paths: resolvePaths(),
    out,
    err,
    // A pack's setup output under the tray: one log event per non-empty line.
    write: events
      ? (text) => {
          for (const line of text.split('\n')) if (line.trim()) asLog(line.trimEnd());
        }
      : stdout,
    signal: stop.signal,
    // The supervisor handles signals itself (spec 05c 5.1): the stop handler must not abort or hard-quit it.
    supervise: async (args) => {
      unwire();
      unwire = () => {};
      const code = await superviseWorker({
        execPath: process.execPath,
        execArgv: process.execArgv,
        script: realpathSync.native(process.argv[1]!),
        args,
        out: err,
        ...(events ? { events: { input: process.stdin, onRestart: () => emit({ event: 'restarting' }) } } : {}),
      });
      if (events) emit({ event: 'stopped', code });
      return code;
    },
    // The child under the tray says which version started once it holds worker.lock: a refused second worker reports
    // only its log line and stopped 1 (spec 06 3.2). It also reports its types (spec 06c 2.2).
    ...(events && isChild
      ? {
          onWorkerStarted: () => emit({ event: 'started', version: FORNAX_VERSION, pid: process.pid }),
          onTypes: (types: TypeState[]) => emit({ event: 'types', types }),
        }
      : {}),
  };
  // Linux: the worker child has a process group of its own; a supervisor gone without passing a signal on (SIGKILL)
  // must not leave it claiming jobs where Ctrl+C no longer reaches it. Its parent gone counts as a first stop.
  const supervised = process.platform !== 'win32' && isChild;
  // A stop already passed on (e.g. by the supervisor) must not become a second signal, the hard quit.
  const unwatch = supervised
    ? watchParent({
        onGone: () => {
          if (!stop.signal.aborted) onSignal('SIGHUP');
        },
      })
    : () => {};
  process.exitCode = await runCli(argv, ctx);
  unwatch();
  unwire();
  unreadStops();
  unwatchInput();
}
