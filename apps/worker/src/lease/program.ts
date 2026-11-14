import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { findBatchOnly, findTool, isBatchFile } from '../checks.js';
import { KILL_GRACE_MS, killTree, type RunOptions, trackTree } from '../process.js';

/** The lease type's label: what `--label` may hold (spec 05a 4.1). */
const LABEL = /^[A-Za-z0-9 ._:/-]*$/;
const LABEL_MAX = 80;

/** Why `program` cannot run without a shell, or null: a batch file (Windows) or nothing startable found. */
export function programProblem(program: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (isBatchFile(program, platform) || findBatchOnly(program, env, platform)) {
    return `${program} is a batch file (.cmd or .bat), which cannot run without a shell; give the program itself (e.g. node.exe, not a .cmd launcher)`;
  }
  if (!findTool(program, env, platform)) return `${program} was not found`;
  return null;
}

/** The default label: the program's file name without directory and extension, cut to what the lease type takes. */
export function defaultLabel(program: string): string | null {
  const base = program.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]*$/, '');
  const clean = name.replace(/[^A-Za-z0-9 ._:/-]/g, '').replace(/^[\s-]+/, '').slice(0, LABEL_MAX).trim();
  return clean || null;
}

/** Why `--label` cannot be the lease's label, or null. */
export function labelProblem(label: string): string | null {
  if (label.length > LABEL_MAX || !LABEL.test(label) || label.startsWith('-')) {
    return `--label may hold at most ${LABEL_MAX} characters: letters, digits, space and . _ : / -, not starting with -`;
  }
  return null;
}

/** The caller's environment for the program: without the client token (spec 05a 4.5 step 5), with FORNAX_LEASE. */
export function leaseEnv(base: NodeJS.ProcessEnv, jobId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^fornax_(client_token|lease)$/i.test(k)) env[k] = v;
  return { ...env, FORNAX_LEASE: jobId };
}

export type ProgramExit = { code: number | null; signal: NodeJS.Signals | null; spawnError: string | null };

/** The program's own exit code; ended by a signal: 128 + its number; else 1 (spec 05a 4.5 step 7). */
export function exitCodeOf(e: ProgramExit): number {
  if (e.code !== null) return e.code;
  const n = e.signal ? constants.signals[e.signal] : undefined;
  return n ? 128 + n : 1;
}

export type StartOptions = {
  cwd: string;
  env: Record<string, string>;
  killGraceMs?: number;
  /** Runs after a hard quit (second Ctrl+C) killed the tree. */
  onHardQuit?: () => void;
  /**
   * Linux: a process group of its own (default). False keeps the program in the caller's group: a nested fornax lease
   * runs in the outer program's group, which the outer wrapper ends as a whole, and the program must end with it.
   */
  ownGroup?: boolean;
} & Pick<RunOptions, 'taskkillProgram' | 'signalGroup'>;

export type Program = {
  readonly pid: number | undefined;
  /** Resolves once the program ended (Linux: and what it left in its group), never rejects. */
  readonly exited: Promise<ProgramExit>;
  /**
   * Linux, in a group of its own: pass a signal on to the program's group (it does not get the terminal's Ctrl+C).
   * Windows, or in the caller's group: nothing to do, the signal reached the program already.
   */
  forward(signal: NodeJS.Signals): void;
  /**
   * End the whole tree (Windows: taskkill /T /F; Linux: SIGTERM to the group, SIGKILL after the grace). Linux, in the
   * caller's group: the program alone, the same way; the group's owner ends the rest.
   */
  kill(): Promise<ProgramExit>;
};

/**
 * Start the program as fornax lease runs it (spec 05a 4.5 step 5): no shell, the caller's stdin, stdout and stderr,
 * on Linux in a process group of its own (unless `ownGroup` is false) so its whole tree can be ended; registered for a
 * hard quit.
 */
export function startProgram(program: string, args: string[], o: StartOptions): Program {
  const seams = { taskkillProgram: o.taskkillProgram, signalGroup: o.signalGroup };
  const grace = o.killGraceMs ?? KILL_GRACE_MS;
  const ownGroup = process.platform !== 'win32' && o.ownGroup !== false;
  let child: ChildProcess;
  try {
    child = spawn(program, args, { cwd: o.cwd, env: o.env, stdio: 'inherit', shell: false, detached: ownGroup });
  } catch (e) {
    // Some failures are thrown instead of emitted, e.g. EINVAL for a batch file on Windows.
    const exited = Promise.resolve<ProgramExit>({ code: null, signal: null, spawnError: (e as NodeJS.ErrnoException).code ?? 'cannot start' });
    return { pid: undefined, exited, forward: () => {}, kill: () => exited };
  }
  let exitedNow = false;
  let killing = false;
  let untrack = () => {};
  const groupAlive = (pid: number): boolean => {
    try {
      (o.signalGroup ?? process.kill)(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exited = new Promise<ProgramExit>((resolve) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      // Only a failed start ends it here; other errors are followed by 'exit'.
      if (child.pid === undefined) resolve({ code: null, signal: null, spawnError: e.code ?? 'cannot start' });
    });
    child.once('exit', (code, signal) => {
      exitedNow = true;
      const finish = () => {
        untrack();
        resolve({ code, signal, spawnError: null });
      };
      // Linux: the program ended, but something it started may live on in its group and hold the card: end the group.
      if (ownGroup && !killing && groupAlive(child.pid!)) {
        void killTree(child.pid!, grace, seams).catch(() => {}).then(finish);
      } else {
        finish();
      }
    });
  });
  if (child.pid !== undefined) untrack = trackTree(child.pid, seams, o.onHardQuit);
  return {
    pid: child.pid,
    exited,
    forward(signal) {
      if (exitedNow || child.pid === undefined || !ownGroup) return;
      try {
        (o.signalGroup ?? process.kill)(-child.pid, signal);
      } catch {
        // Already gone.
      }
    },
    async kill() {
      if (child.pid === undefined) return exited;
      killing = true;
      if (process.platform !== 'win32' && !ownGroup) {
        // Linux, in the caller's group: only the program itself; whoever owns the group ends the rest of it.
        if (!exitedNow) await endAlone(child, exited, grace);
      } else if (!(exitedNow && process.platform === 'win32')) {
        // Windows: after the exit the pid may be reused; taskkill must not touch it.
        await killTree(child.pid, grace, seams).catch(() => {});
      }
      if (!exitedNow) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
      return exited;
    },
  };
}

/** SIGTERM to one process, SIGKILL (by the caller) if it is still there after the grace. */
async function endAlone(child: ChildProcess, exited: Promise<ProgramExit>, graceMs: number): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
  clearTimeout(timer);
}
