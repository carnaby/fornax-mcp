import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** The tool's log keeps its last 1 MiB (spec 6.4). */
export const LOG_LIMIT = 1024 * 1024;
/** Linux: SIGTERM to the process group, SIGKILL this much later (spec 7.4 step 5). */
export const KILL_GRACE_MS = 10_000;
/** After the tool exits, wait this long for its pipes to close (a leftover grandchild may hold them open). */
const PIPE_CLOSE_MS = 1000;

export type Progress = { progress: number; message: string | null };

export type RunOptions = {
  /** argv[0] is the program; no shell is involved. */
  argv: string[];
  cwd: string;
  /** The complete environment of the process; build it with childEnv. */
  env: Record<string, string>;
  timeoutMs?: number;
  /** Abort to cancel: the whole process tree is killed. */
  signal?: AbortSignal;
  killGraceMs?: number;
  onProgress?: (p: Progress) => void;
  /** Log text as it arrives (a pack's setup shown live). */
  onOutput?: (text: string) => void;
  /** Test seam: the program used for taskkill on Windows. */
  taskkillProgram?: string;
  /** Test seam: replaces process.kill for the Linux process-group signals. */
  signalGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

export type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  canceled: boolean;
  /** Set when the program could not be started at all (not found, not executable). */
  spawnError: string | null;
  log: string;
};

/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** A stdout line `{"progress": 0..1, "message"?: string}` and nothing else; null for any other line. */
export function parseProgress(line: string): Progress | null {
  const t = line.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'progress' && k !== 'message')) return null;
  if (typeof o.progress !== 'number' || !Number.isFinite(o.progress) || o.progress < 0 || o.progress > 1) return null;
  if (o.message !== undefined && typeof o.message !== 'string') return null;
  return { progress: o.progress, message: typeof o.message === 'string' ? cut(o.message, 200) : null };
}

/** The last `limit` bytes of everything pushed, cut at a UTF-8 character boundary. */
export class LogBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit = LOG_LIMIT) {}

  push(text: string): void {
    if (!text) return;
    const b = Buffer.from(text, 'utf8');
    this.chunks.push(b);
    this.size += b.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) this.size -= this.chunks.shift()!.length;
  }

  toString(): string {
    let all = Buffer.concat(this.chunks);
    if (all.length > this.limit) {
      let start = all.length - this.limit;
      // Skip continuation bytes (10xxxxxx) so the text does not start inside a character.
      while (start < all.length && (all[start]! & 0xc0) === 0x80) start++;
      all = all.subarray(start);
    }
    return all.toString('utf8');
  }
}

/** The last non-empty line of a log, at most 300 characters: a short reason for an error message. */
export function logTail(log: string): string {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return last.length > 300 ? `${last.slice(0, 300)}…` : last;
}

/** The worker's environment without any FORNAX_* variable (the token never reaches a tool), plus `extra`. */
export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^fornax_/i.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/** Kill a process and everything it started. Windows: taskkill /T /F. Linux: SIGTERM to its group, SIGKILL after the grace period. */
export async function killTree(
  pid: number,
  graceMs: number = KILL_GRACE_MS,
  seams: Pick<RunOptions, 'taskkillProgram' | 'signalGroup'> = {},
): Promise<void> {
  const { taskkillProgram, signalGroup } = seams;
  if (process.platform === 'win32') {
    const taskkill = taskkillProgram ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    // Never rejects; a failure is left to the caller's last-resort kill of the tool itself.
    await new Promise<void>((resolve) => {
      try {
        const k = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('error', () => resolve());
        k.on('exit', () => resolve());
      } catch {
        resolve();
      }
    });
    return;
  }
  const group = (sig: NodeJS.Signals | 0): boolean => {
    try {
      (signalGroup ?? process.kill)(-pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!group('SIGTERM')) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!group(0)) return;
  }
  group('SIGKILL');
}

/** Run a tool without a shell. Resolves when it ended and, if it was stopped, after its whole tree is gone. */
export function runProcess(opts: RunOptions): Promise<RunResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: null, signal: null, timedOut: false, canceled: true, spawnError: null, log: '' });
  const [program, ...args] = opts.argv;
  if (program === undefined) throw new Error('runProcess needs a program');
  const log = new LogBuffer();
  const write = (text: string) => {
    if (!text) return;
    log.push(text);
    opts.onOutput?.(text);
  };

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Linux: a new process group (detached), so the whole tree can be signalled at once. Windows: taskkill /T finds the tree.
      child = spawn(program, args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Some failures are thrown instead of emitted, e.g. EINVAL for a .cmd/.bat on Windows (no shell) or an invalid argument.
      resolve({ code: null, signal: null, timedOut: false, canceled: false, spawnError: (e as Error).message, log: '' });
      return;
    }
    let timedOut = false;
    let canceled = false;
    let settled = false;
    let stopping = false;
    let exited = false;
    let killing: Promise<void> = Promise.resolve();
    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    let pipeTimer: NodeJS.Timeout | undefined;

    const stop = () => {
      if (stopping || child.pid === undefined) return;
      // Windows: after exit the pid may be reused, taskkill must not touch it.
      if (exited && process.platform === 'win32') return;
      stopping = true;
      killing = killTree(child.pid, opts.killGraceMs ?? KILL_GRACE_MS, opts)
        .catch(() => {})
        .then(() => {
          // Last resort when the tree kill did not end the tool (taskkill failed, EPERM on the group).
          // Guarded by `exited`: the pid of a tool that already ended must never be signalled.
          if (exited) return;
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        });
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, opts.timeoutMs)
        : undefined;
    const onAbort = () => {
      canceled = true;
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const outText = new StringDecoder('utf8');
    const errText = new StringDecoder('utf8');
    let line = '';
    const takeLine = (l: string) => {
      const p = parseProgress(l);
      if (p) opts.onProgress?.(p);
      else write(`${l}\n`);
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      line += outText.write(chunk);
      for (let i = line.indexOf('\n'); i >= 0; i = line.indexOf('\n')) {
        takeLine(line.slice(0, i).replace(/\r$/, ''));
        line = line.slice(i + 1);
      }
      // A tool that never ends its line still has a bounded buffer here.
      if (line.length > 64 * 1024) {
        write(line);
        line = '';
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => write(errText.write(chunk)));

    const finish = async (spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      const rest = line + outText.end();
      if (rest) takeLine(rest);
      write(errText.end());
      await killing;
      resolve({ ...exit, timedOut, canceled, spawnError, log: log.toString() });
    };

    child.on('error', (e) => {
      // Only a failed start ends the run here; other errors are followed by 'close' anyway.
      if (child.pid === undefined) void finish(e.message);
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      exited = true;
      pipeTimer = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
        void finish(null);
      }, PIPE_CLOSE_MS);
    });
    child.on('close', () => void finish(null));
  });
}
