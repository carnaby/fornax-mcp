import { setTimeout as sleep } from 'node:timers/promises';
import type { ClientJobView, Priority } from '@fornax/protocol';
import { ApiError, isTransient } from '../api.js';
import { oneLine } from '../checks.js';
import type { ClientApi } from '../client-api.js';
import { ALIVE_MS, LeaseFiles, sweepLeases } from './files.js';
import { exitCodeOf, leaseEnv, type Program, type ProgramExit, programProblem, startProgram } from './program.js';

/** Spec 05a 4.6: the wrapper's own exit codes; any other code is the program's. */
export const LEASE_EXIT = { usage: 120, noLease: 121, gaveUp: 122, lost: 123, interrupted: 130 } as const;
export const LEASE_TYPE = 'lease';
const JOB_ID = /^[0-9A-Za-z]{1,64}$/;
/** Windows STATUS_CONTROL_C_EXIT: how a console program ends on Ctrl+C. */
const CONTROL_C_EXIT = 0xc000013a;

export type LeaseRequest = {
  minutes: number;
  waitMinutes: number | null;
  rerun: boolean;
  /** None: the type's default (spec 07 § 4.4). */
  priority?: Priority;
  label: string | null;
  /** Spec 09 § 2.3: who asks for the lease (--agent or FORNAX_AGENT); null: none. */
  agent: string | null;
  program: string;
  args: string[];
};
export type LeaseClient = Pick<ClientApi, 'submit' | 'job' | 'cancel'>;
export type LeaseTimings = {
  /** Seconds one GET ?wait may wait (spec 05a 4.5: 25). */
  pollS: number;
  aliveMs: number;
  /** A repeated line (the queue note, an unreachable server) at most this often. */
  noteMs: number;
  /** After Ctrl+C the program gets this long to end by itself. */
  interruptMs: number;
  killGraceMs: number;
  /** The length of a minute for --minutes and --wait-minutes; tests shorten it. */
  minuteMs: number;
  backoff: { baseMs: number; maxMs: number };
};
export const LEASE_TIMINGS: LeaseTimings = {
  pollS: 25, aliveMs: ALIVE_MS, noteMs: 60_000, interruptMs: 10_000, killGraceMs: 10_000, minuteMs: 60_000, backoff: { baseMs: 1000, maxMs: 60_000 },
};

export type LeaseDeps = {
  api: LeaseClient;
  leasesDir: string;
  /** One line for the user (stderr); runLease adds the "fornax lease: " prefix. */
  say: (line: string) => void;
  /** The wrapper was told to stop (Ctrl+C, SIGTERM, SIGHUP, SIGQUIT); its reason is the signal's name, passed on to the program. */
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timings?: Partial<LeaseTimings>;
  taskkillProgram?: string;
  signalGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

/** The work was given up: the wrapper was interrupted, or (inside one run) the run is over. */
class Stopped extends Error {}
/** --wait-minutes ran out before the lease came, also while the server could not be reached (spec 05a 4.5 step 3). */
class GaveUp extends Error {}

const never = new Promise<never>(() => {});
/** The longest delay a Node timer takes; a longer one would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Resolves with `value` when `signal` aborts; the listener is removed when `until` aborts. */
function onAbort<T>(signal: AbortSignal, value: T, until: AbortSignal): Promise<T> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(value);
    const fire = () => resolve(value);
    signal.addEventListener('abort', fire, { once: true });
    until.addEventListener('abort', () => signal.removeEventListener('abort', fire), { once: true });
  });
}

const signalOf = (signal: AbortSignal): NodeJS.Signals =>
  typeof signal.reason === 'string' && /^SIG[A-Z0-9]+$/.test(signal.reason) ? (signal.reason as NodeJS.Signals) : 'SIGINT';

const endedText = (v: ClientJobView): string =>
  v.state === 'canceled' ? 'the job was canceled' : v.state === 'failed' ? `the job failed${v.error ? ` (${oneLine(v.error, 300)})` : ''}` : `the job ${v.state}`;

/** A program that looks ended by the same Ctrl+C as the wrapper. */
const looksInterrupted = (e: ProgramExit): boolean => e.signal === 'SIGINT' || e.code === CONTROL_C_EXIT;

/** A refusal every request of the flow reads the same way: the client token (401, 403) or a job that is gone (404). */
type Refusal = 'token' | 'gone';
const refusalOf = (e: unknown): Refusal | null => {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401 || e.status === 403) return 'token';
  return e.status === 404 ? 'gone' : null;
};
const TOKEN_REFUSED = 'the client token was refused (store a new one with fornax lease token)';

/** What a cancel did: the job was canceled, it had ended already (404, 409), or why it could not be canceled. */
type Canceled = { kind: 'canceled' } | { kind: 'over' } | { kind: 'failed'; why: string };

/**
 * How a line ends after the job was to be canceled. `claimed`: the worker runs the lease now, so a lease nobody renews
 * ends itself within a minute; else the job may still wait in the queue (and only once claimed end that way).
 */
const canceledText = (id: string, c: Canceled, claimed: boolean): string => {
  if (c.kind === 'canceled') return 'the job was canceled';
  if (c.kind === 'over') return 'the job had already ended';
  return claimed
    ? `the job could not be canceled (${c.why}); a lease nobody uses ends itself within a minute`
    : `the job could not be canceled (${c.why}); job ${id} may still wait in the queue; once the worker takes it, its lease ends itself within a minute, as nobody uses it`;
};

type RunEnd =
  | { kind: 'exited'; exit: ProgramExit }
  | { kind: 'interrupt' }
  | { kind: 'time' }
  | { kind: 'given_back'; view: ClientJobView }
  | { kind: 'ended'; view: ClientJobView }
  | { kind: 'refused'; why: string };

/**
 * `fornax lease -- <program>` (spec 05a 4.5): get the GPU in queue order as a `lease` job, run the program while the
 * job runs, give the card back at every end. Returns the exit code (spec 05a 4.6).
 */
export async function runLease(req: LeaseRequest, d: LeaseDeps): Promise<number> {
  const t: LeaseTimings = { ...LEASE_TIMINGS, ...d.timings };
  const say = (line: string) => d.say(`fornax lease: ${line}`);
  /** --wait-minutes counts for each wait for the lease: from before the submit, and again after every give-back. */
  const waitDeadline = (): number => (req.waitMinutes === null ? Infinity : Date.now() + req.waitMinutes * t.minuteMs);
  const gaveUpText = `gave up waiting after ${req.waitMinutes} min`;

  /**
   * Network errors, 5xx and unreadable answers: again after a growing pause, a line at most once a minute. A lease is
   * never skipped; only `deadline` (--wait-minutes) ends the retries, with GaveUp. `fn` gets the signal to pass on.
   */
  const persist = async <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    o: { line?: string; deadline?: number } = {},
  ): Promise<T> => {
    const deadline = o.deadline ?? Infinity;
    let delay = t.backoff.baseMs;
    let saidAt = -Infinity;
    for (;;) {
      if (signal.aborted) throw new Stopped();
      const left = deadline - Date.now();
      if (left <= 0) throw new GaveUp();
      // A request that hangs must not outlast the deadline either (the timer of AbortSignal.timeout holds nothing open).
      const late = left <= MAX_TIMER_MS ? AbortSignal.timeout(Math.ceil(left)) : null;
      try {
        return await fn(late ? AbortSignal.any([signal, late]) : signal);
      } catch (e) {
        if (signal.aborted) throw new Stopped();
        if (late?.aborted) throw new GaveUp();
        if (!isTransient(e)) throw e;
        if (Date.now() - saidAt >= t.noteMs) {
          say(o.line ?? 'the server cannot be reached, retrying');
          saidAt = Date.now();
        }
        try {
          await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), undefined, { signal });
        } catch {
          throw new Stopped();
        }
        delay = Math.min(delay * 2, t.backoff.maxMs);
      }
    }
  };

  /** Cancel the job, best effort: a few tries, never interrupted (it also runs after Ctrl+C). */
  const cancelJob = async (id: string): Promise<Canceled> => {
    let why = 'the server cannot be reached';
    for (let i = 0; i < 3; i++) {
      if (i > 0) await sleep(t.backoff.baseMs);
      try {
        await d.api.cancel(id);
        return { kind: 'canceled' };
      } catch (e) {
        const refusal = refusalOf(e);
        // Gone (404) or already in a final state (409): nothing is left to cancel.
        if (refusal === 'gone' || (e instanceof ApiError && e.status === 409)) return { kind: 'over' };
        if (refusal === 'token') return { kind: 'failed', why: 'the client token was refused' };
        if (e instanceof ApiError && e.status < 500) return { kind: 'failed', why: oneLine(e.message, 300) };
        // Unreachable, a 5xx, or an answer that cannot be read: try again.
        why = e instanceof ApiError ? `the server answered ${e.status}` : 'the server cannot be reached';
      }
    }
    return { kind: 'failed', why };
  };

  const launch = (id: string, o: { nested?: boolean; onHardQuit?: () => void } = {}): Program =>
    startProgram(req.program, req.args, {
      cwd: d.cwd, env: leaseEnv(d.env, id, req.agent), killGraceMs: t.killGraceMs, taskkillProgram: d.taskkillProgram, signalGroup: d.signalGroup,
      onHardQuit: o.onHardQuit,
      // Nested: in the outer program's group, so the outer wrapper's kill of that group reaches this program too.
      ownGroup: !o.nested,
    });

  /** Ctrl+C reached the program too (Windows: the same console; Linux: passed on to its group): time to end, then the kill. */
  const stopGently = async (program: Program): Promise<void> => {
    program.forward(signalOf(d.signal));
    const pause = new AbortController();
    const ended = await Promise.race([
      program.exited.then(() => true),
      sleep(t.interruptMs, false, { signal: pause.signal }).catch(() => false),
    ]);
    // The pause must not keep the wrapper alive once the program ended by itself.
    pause.abort();
    if (!ended) await program.kill();
  };

  /** Spec 05a 4.5 step 1: inside a lease the program runs at once, under the outer wrapper's lease and care. */
  const nested = async (id: string): Promise<number> => {
    if (!JOB_ID.test(id)) {
      say('FORNAX_LEASE does not name a lease job');
      return LEASE_EXIT.lost;
    }
    let v: ClientJobView;
    try {
      v = await persist((signal) => d.api.job(id, { signal }), d.signal);
    } catch (e) {
      if (e instanceof Stopped) return LEASE_EXIT.interrupted;
      const refusal = refusalOf(e);
      if (refusal === 'token') {
        say(TOKEN_REFUSED);
        return LEASE_EXIT.noLease;
      }
      if (refusal === 'gone') {
        say(`the lease ${id} this runs in is not found (another client's, or gone)`);
        return LEASE_EXIT.lost;
      }
      throw e;
    }
    // A running job of another type holds the card for its own tool, not for this program.
    if (v.type !== LEASE_TYPE) {
      say(`FORNAX_LEASE names job ${id}, which is not a lease`);
      return LEASE_EXIT.lost;
    }
    if (v.state !== 'running') {
      say(`the lease ${id} this runs in is ${v.state}`);
      return LEASE_EXIT.lost;
    }
    if (d.signal.aborted) return LEASE_EXIT.interrupted;
    const program = launch(id, { nested: true });
    const over = new AbortController();
    try {
      const end = await Promise.race([
        program.exited.then((exit) => ({ kind: 'exited' as const, exit })),
        onAbort(d.signal, { kind: 'interrupt' as const }, over.signal),
      ]);
      if (end.kind === 'interrupt') {
        await stopGently(program);
        return LEASE_EXIT.interrupted;
      }
      if (end.exit.spawnError) {
        say(`${req.program} could not be started (${end.exit.spawnError})`);
        return LEASE_EXIT.usage;
      }
      return exitCodeOf(end.exit);
    } finally {
      over.abort();
    }
  };

  /** Spec 05a 4.5 step 3: wait in the queue until `deadline`. The job once it runs, or the exit code. */
  const waitForLease = async (id: string, first: ClientJobView, deadline: number): Promise<ClientJobView | number> => {
    let shown: string | null = null;
    let shownAt = -Infinity;
    let v = first;
    try {
      for (;;) {
        if (v.state === 'running') return v;
        if (v.state !== 'queued') {
          say(`the lease ended before the program started: ${endedText(v)}`);
          return LEASE_EXIT.lost;
        }
        const note = v.note ? oneLine(v.note, 300) : null;
        if (note && (note !== shown || Date.now() - shownAt >= t.noteMs)) {
          say(note);
          shown = note;
          shownAt = Date.now();
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new GaveUp();
        // A note shown is shown again after noteMs even when nothing changes: the wait ends in time to do it.
        const untilNote = shown === null ? Infinity : shownAt + t.noteMs - Date.now();
        const waitS = Math.max(1, Math.min(t.pollS, Math.ceil(left / 1000), Math.ceil(untilNote / 1000)));
        const change = v.change;
        v = await persist((signal) => d.api.job(id, { wait: waitS, change, signal }), d.signal, { deadline });
      }
    } catch (e) {
      // The job may have been claimed meanwhile, but as far as this wrapper knows it is queued.
      if (e instanceof Stopped) {
        say(`interrupted; ${canceledText(id, await cancelJob(id), false)}`);
        return LEASE_EXIT.interrupted;
      }
      if (e instanceof GaveUp) {
        say(`${gaveUpText}; ${canceledText(id, await cancelJob(id), false)}`);
        return LEASE_EXIT.gaveUp;
      }
      const refusal = refusalOf(e);
      if (refusal === 'token') {
        say(TOKEN_REFUSED);
        return LEASE_EXIT.noLease;
      }
      if (refusal === 'gone') {
        say(`the lease ended before the program started: job ${id} is gone`);
        return LEASE_EXIT.lost;
      }
      // Unexpected: no job may be left waiting for a wrapper that is gone.
      await cancelJob(id);
      throw e;
    }
  };

  /** Spec 05a 4.5 step 6: follow the job while the program runs; resolves only when the lease is no longer this run's. */
  const watch = async (id: string, running: ClientJobView, signal: AbortSignal): Promise<RunEnd> => {
    let v = running;
    try {
      for (;;) {
        const change = v.change;
        v = await persist((s) => d.api.job(id, { wait: t.pollS, change, signal: s }), signal, {
          line: 'the server cannot be reached; the program goes on, retrying',
        });
        // Given back (the worker stopped or restarted), and maybe already taken again: another claim, not this run's.
        if (v.state === 'queued' || (v.state === 'running' && v.started_at !== running.started_at)) return { kind: 'given_back', view: v };
        if (v.state !== 'running') return { kind: 'ended', view: v };
      }
    } catch (e) {
      // The run is over and the race has its answer.
      if (e instanceof Stopped) return never;
      const refusal = refusalOf(e);
      if (refusal) return { kind: 'refused', why: refusal === 'token' ? 'the client token was refused' : `job ${id} is gone` };
      throw e;
    }
  };

  /** Spec 05a 4.5 steps 4–8: one run of the program under the claim `running`; `again` when --rerun waits for the lease. */
  const runOnce = async (id: string, files: LeaseFiles, running: ClientJobView): Promise<number | { again: ClientJobView }> => {
    const startedAt = running.started_at ?? '';
    // Ctrl+C while the lease came back (--rerun): the program does not start again.
    // Both cases: the worker runs the lease (`running`), and this run never renews it.
    if (d.signal.aborted) {
      say(`interrupted; ${canceledText(id, await cancelJob(id), true)}`);
      return LEASE_EXIT.interrupted;
    }
    // Without alive the tool ends the lease within a minute: do not start a program it would not cover.
    if (!files.alive(startedAt)) {
      say(`the lease files cannot be written in ${files.dir}; ${canceledText(id, await cancelJob(id), true)}`);
      return LEASE_EXIT.noLease;
    }
    say(`the lease started (job ${id}); running ${req.program}`);
    const program = launch(id, { onHardQuit: () => void files.done(startedAt) });
    const over = new AbortController();
    const renew = setInterval(() => void files.alive(startedAt), t.aliveMs);
    try {
      const end: RunEnd = await Promise.race([
        program.exited.then((exit): RunEnd => ({ kind: 'exited', exit })),
        watch(id, running, over.signal),
        sleep(req.minutes * t.minuteMs, undefined, { signal: over.signal }).then((): RunEnd => ({ kind: 'time' }), () => never),
        onAbort<RunEnd>(d.signal, { kind: 'interrupt' }, over.signal),
      ]);
      switch (end.kind) {
        case 'exited': {
          // The same Ctrl+C may reach the program first: give the wrapper's own signal a moment.
          if (looksInterrupted(end.exit) && !d.signal.aborted) await sleep(100);
          files.done(startedAt);
          if (d.signal.aborted) {
            say('interrupted; the program was stopped');
            return LEASE_EXIT.interrupted;
          }
          if (end.exit.spawnError) {
            say(`${req.program} could not be started (${end.exit.spawnError})`);
            return LEASE_EXIT.usage;
          }
          return exitCodeOf(end.exit);
        }
        case 'interrupt':
          await stopGently(program);
          files.done(startedAt);
          say('interrupted; the program was stopped');
          return LEASE_EXIT.interrupted;
        case 'time':
          await program.kill();
          files.done(startedAt);
          say(`the lease time ran out (${req.minutes} min); the program was stopped`);
          return LEASE_EXIT.lost;
        case 'ended':
          await program.kill();
          files.done(startedAt);
          say(`the lease was lost: ${endedText(end.view)}; the program was stopped`);
          return LEASE_EXIT.lost;
        case 'refused':
          await program.kill();
          files.done(startedAt);
          say(`the lease was lost: ${end.why}; the program was stopped`);
          return LEASE_EXIT.lost;
        case 'given_back': {
          // No done: the job goes on, and a later claim of it must not end at once.
          await program.kill();
          if (req.rerun) {
            say('the worker gave the lease back; the program will start again when the lease returns');
            return { again: end.view };
          }
          // Given back: the job is queued again (or already claimed again, with no alive of that claim).
          const c = await cancelJob(id);
          const tail = c.kind === 'canceled' ? '' : `; ${canceledText(id, c, end.view.state === 'running')}`;
          say(`the lease was lost: the worker gave it back (it stopped or restarted); the program was stopped${tail}`);
          return LEASE_EXIT.lost;
        }
      }
    } catch (e) {
      await program.kill();
      files.done(startedAt);
      throw e;
    } finally {
      over.abort();
      clearInterval(renew);
    }
  };

  const problem = programProblem(req.program, d.env);
  if (problem) {
    say(problem);
    return LEASE_EXIT.usage;
  }
  // A blank value (`FORNAX_LEASE= cmd` in bash) is not a lease: taken as not set.
  const outer = d.env.FORNAX_LEASE?.trim();
  if (outer) return nested(outer);

  let deadline = waitDeadline();
  let view: ClientJobView;
  try {
    const params = { minutes: req.minutes, ...(req.label ? { label: req.label } : {}) };
    view = await persist(
      (signal) => d.api.submit({ type: LEASE_TYPE, params, ...(req.priority ? { priority: req.priority } : {}), ...(req.agent ? { agent: req.agent } : {}) }, signal),
      d.signal, { deadline },
    );
  } catch (e) {
    if (e instanceof Stopped) {
      say('interrupted before a lease was asked for');
      return LEASE_EXIT.interrupted;
    }
    if (e instanceof GaveUp) {
      say(`${gaveUpText}; the server cannot be reached`);
      return LEASE_EXIT.gaveUp;
    }
    if (refusalOf(e) === 'token') {
      say(TOKEN_REFUSED);
      return LEASE_EXIT.noLease;
    }
    if (e instanceof ApiError && e.status === 422 && /not offered/.test(e.message)) {
      say('the worker does not offer the job type lease: run fornax types install lease on the worker PC, then restart the worker');
      return LEASE_EXIT.noLease;
    }
    if (e instanceof ApiError) {
      say(`the server refused the lease: ${oneLine(e.message, 300)}`);
      return LEASE_EXIT.noLease;
    }
    throw e;
  }
  const id = view.id;
  sweepLeases(d.leasesDir);
  const files = new LeaseFiles(d.leasesDir, id);
  for (;;) {
    const got = await waitForLease(id, view, deadline);
    if (typeof got === 'number') return got;
    const r = await runOnce(id, files, got);
    if (typeof r === 'number') return r;
    view = r.again;
    deadline = waitDeadline();
  }
}
