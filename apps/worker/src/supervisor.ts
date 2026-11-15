import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { RESTART_EXIT } from './restart.js';

export type SuperviseOptions = {
  execPath: string;
  execArgv: string[];
  /** The fornax.mjs to run; after fornax update it is the new file at the same path. */
  script: string;
  /** What follows `worker --child` (e.g. --once). */
  args: string[];
  out: (line: string) => void;
  /** Where signals come from (process; tests pass an emitter). */
  signals?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
  platform?: NodeJS.Platform;
  now?: () => number;
  maxRestarts?: number;
  windowMs?: number;
  /** Test seam: each child as it starts. */
  onChild?: (child: ChildProcess) => void;
};

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
/** The worker child does not handle SIGQUIT (Ctrl+\ would kill it mid-job): it gets SIGTERM, a graceful stop, instead. */
const passedAs = (s: (typeof FORWARDED)[number]): NodeJS.Signals => (s === 'SIGQUIT' ? 'SIGTERM' : s);
/** Windows: console events the child gets itself; the supervisor must only not die of them. */
const IGNORED_ON_WINDOWS = ['SIGINT', 'SIGHUP', 'SIGBREAK'] as const;

/**
 * `fornax worker` (spec 05c 5.1): run the worker as `worker --child`, start it again when it exits with RESTART_EXIT,
 * otherwise end with its exit code. Linux: the child has a process group of its own, so terminal and systemd signals
 * reach only the supervisor, which passes each one on once (the child counts them: first = stop, second = quit;
 * SIGQUIT goes on as SIGTERM).
 * Windows: the child shares the console and gets Ctrl+C itself; the supervisor ignores it. A stop asked for while the
 * worker was about to restart is kept: a following exit 75 ends the supervisor with 0 instead of starting it again.
 */
export async function superviseWorker(o: SuperviseOptions): Promise<number> {
  const signals = o.signals ?? process;
  const windows = (o.platform ?? process.platform) === 'win32';
  const now = o.now ?? Date.now;
  const maxRestarts = o.maxRestarts ?? 3;
  const windowMs = o.windowMs ?? 60_000;
  let child: ChildProcess | null = null;
  let stopRequested = false;

  const pass = (signal: NodeJS.Signals) => {
    stopRequested = true;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const ignore = () => {
    stopRequested = true;
  };
  const wired: [string, (s: NodeJS.Signals) => void][] = windows
    ? IGNORED_ON_WINDOWS.map((s) => [s, ignore])
    : FORWARDED.map((s) => [s, () => pass(passedAs(s))]);
  for (const [s, h] of wired) signals.on(s, h);

  const restarts: number[] = [];
  try {
    for (;;) {
      const code = await new Promise<number>((resolve) => {
        const c = spawn(o.execPath, [...o.execArgv, o.script, 'worker', '--child', ...o.args], {
          stdio: 'inherit',
          detached: !windows,
          windowsHide: false,
        });
        child = c;
        o.onChild?.(c);
        c.once('error', (e) => {
          o.out(`cannot start the worker (${(e as NodeJS.ErrnoException).code ?? e.message})`);
          resolve(1);
        });
        c.once('exit', (exitCode, signal) => {
          resolve(exitCode ?? (signal && !windows ? 128 + (constants.signals[signal] ?? 0) : 1));
        });
      });
      child = null;
      if (code !== RESTART_EXIT) return code;
      if (stopRequested) return 0;
      const t = now();
      restarts.push(t);
      while (restarts.length && t - restarts[0]! > windowMs) restarts.shift();
      if (restarts.length > maxRestarts) {
        o.out(`the worker asked to restart ${restarts.length} times in a minute; not restarting`);
        return 1;
      }
    }
  } finally {
    for (const [s, h] of wired) signals.off(s, h);
  }
}

/**
 * `worker --child` on Linux runs in a process group of its own, so a supervisor that dies without passing a signal on
 * (SIGKILL, a crash) would leave it running where Ctrl+C no longer reaches it. This polls the parent pid and calls
 * `onGone` once when it changed (the child was re-parented). Returns the stop; the timer never keeps the process alive.
 */
export function watchParent(o: { getPpid?: () => number; intervalMs?: number; onGone: () => void }): () => void {
  const getPpid = o.getPpid ?? (() => process.ppid);
  const first = getPpid();
  const timer = setInterval(() => {
    if (getPpid() === first) return;
    clearInterval(timer);
    o.onGone();
  }, o.intervalMs ?? 2000);
  timer.unref();
  return () => clearInterval(timer);
}
