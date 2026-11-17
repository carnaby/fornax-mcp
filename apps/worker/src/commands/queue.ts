import { setTimeout as sleep } from 'node:timers/promises';
import type { MoveTarget, OperatorJob, OperatorQueue, Priority } from '@fornax/protocol';
import { ApiError, NetworkError, WorkerApi } from '../api.js';
import { ConfigError, readToken, readWorkerConfig, serverWarning } from '../config.js';
import type { Ctx } from './context.js';

/**
 * The operator's commands talk to the server with the worker token. Their warnings go to stderr: stdout of
 * `fornax queue --json` is read by programs.
 */
export function connectOperator(ctx: Ctx): { api: WorkerApi; say: (line: string) => void } {
  const say = ctx.err ?? ctx.out;
  const token = readToken(ctx.paths);
  if (!token) throw new ConfigError('this computer is not paired as a worker (fornax worker pair)');
  const config = readWorkerConfig(ctx.paths);
  const warning = serverWarning(config.server);
  if (warning) say(warning);
  const api = ctx.makeApi?.(config.server, token) ?? new WorkerApi({ server: config.server, token, onWarning: (m) => say(`warning: ${m}`) });
  return { api, say };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A local clock time, HH:MM. */
const clock = (isoTime: string) => {
  const d = new Date(isoTime);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** m:ss, or h:mm:ss from an hour on; never negative. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** What a job works on: its label, else its first input's file name, else its group. */
const what = (j: OperatorJob): string => j.label ?? Object.values(j.inputs).find((n) => n) ?? j.group ?? '';
const cols = (...parts: string[]) => parts.filter((p) => p !== '').join('  ');

function headline(q: OperatorQueue): string {
  const queue = q.paused ? (q.running ? 'queue pausing after the running job' : 'queue paused') : 'queue active';
  const worker = q.worker.online
    ? `worker online${q.worker.version ? ` (${q.worker.version})` : ''}`
    : q.worker.last_seen
      ? `worker offline since ${clock(q.worker.last_seen)}`
      : 'worker never connected';
  return `${queue} · ${worker}`;
}

/** Spec 06 3.1: the queue for a person, one job per line (the last `finishedShown` finished jobs). */
export function renderQueue(q: OperatorQueue, finishedShown = 10): string[] {
  const now = Date.parse(q.server_time);
  const lines = [headline(q)];
  if (q.worker.waiting) lines.push(q.worker.waiting.message);
  const r = q.running;
  if (r) {
    const elapsed = r.started_at ? duration(now - Date.parse(r.started_at)) : '';
    const progress = r.progress !== null ? `${Math.round(r.progress * 100)} %` : '';
    lines.push(cols('running ', r.type, r.owner ?? '?', what(r), elapsed, progress, r.progress_message ?? '', r.id));
  } else {
    lines.push('running   nothing');
  }
  if (!q.queued.length) lines.push('waiting   nothing');
  q.queued.forEach((j, i) => {
    // Spec 07 § 4.3: high and idle are said; normal is the plain case.
    const priority = j.priority === 'high' ? 'high' : j.priority === 'idle' ? (j.idle_since ? `idle since ${clock(j.idle_since)}` : 'idle') : '';
    const notes = [priority, j.type_unavailable ? 'type not offered' : '', j.run_after ? `retry at ${clock(j.run_after)}` : ''].filter(Boolean).join(', ');
    lines.push(cols(i === 0 ? 'waiting ' : '        ', String(i + 1), j.type, j.owner ?? '?', what(j), `waits ${duration(now - Date.parse(j.created_at))}`, notes, j.id));
  });
  q.finished.slice(0, finishedShown).forEach((j, i) => {
    const took = j.started_at && j.finished_at ? `took ${duration(Date.parse(j.finished_at) - Date.parse(j.started_at))}` : '';
    lines.push(cols(i === 0 ? 'finished' : '        ', j.state, j.type, j.owner ?? '?', what(j), took, j.finished_at ? `at ${clock(j.finished_at)}` : '', j.id));
    if (j.state === 'failed' && j.error) lines.push(`          ${j.error}`);
  });
  return lines;
}

export const jsonLine = (q: OperatorQueue): string => JSON.stringify({ ok: true, ...q });

/** `fornax queue [--json]`. */
export async function queueShow(ctx: Ctx, o: { json: boolean }): Promise<number> {
  const { api } = connectOperator(ctx);
  const q = await api.operatorQueue();
  if (o.json) ctx.out(jsonLine(q));
  else for (const line of renderQueue(q)) ctx.out(line);
  return 0;
}

const placeText = (t: MoveTarget): string => ('to' in t ? `to the ${t.to}` : 'before' in t ? `before ${t.before}` : `after ${t.after}`);

/** `fornax queue move <id> (--top | --bottom | --before <id> | --after <id>)`. */
export async function queueMove(ctx: Ctx, id: string, target: MoveTarget): Promise<number> {
  await connectOperator(ctx).api.moveJob(id, target);
  ctx.out(`moved job ${id} ${placeText(target)}`);
  return 0;
}

/** `fornax queue cancel <id>`: any client's job. */
export async function queueCancel(ctx: Ctx, id: string): Promise<number> {
  await connectOperator(ctx).api.cancelAnyJob(id);
  ctx.out(`canceled job ${id}`);
  return 0;
}

/** `fornax queue priority <id> high|normal|idle [--json]` (spec 07 § 4.3); low is taken as normal. */
export async function queuePriority(ctx: Ctx, id: string, priority: Priority, o: { json: boolean } = { json: false }): Promise<number> {
  const q = await connectOperator(ctx).api.setPriority(id, priority);
  ctx.out(o.json ? jsonLine(q) : `job ${id} is ${priority} now`);
  return 0;
}

/** `fornax queue requeue <id> [--idle] [--json]`: a running job back to the queue (Pause with --idle). */
export async function queueRequeue(ctx: Ctx, id: string, o: { idle: boolean; json: boolean }): Promise<number> {
  const q = await connectOperator(ctx).api.requeueJob(id, o.idle);
  ctx.out(o.json ? jsonLine(q) : o.idle ? `job ${id} stops and waits in Idle` : `job ${id} stops and goes back to the queue`);
  return 0;
}

/** `fornax queue start-idle [--json]`: every idle job becomes normal. */
export async function queueStartIdle(ctx: Ctx, o: { json: boolean } = { json: false }): Promise<number> {
  const q = await connectOperator(ctx).api.startIdle();
  ctx.out(o.json ? jsonLine(q) : 'the idle jobs wait for their turn now');
  return 0;
}

/**
 * `fornax queue pause|resume [--json]`. With --json the queue the server answered with, as one line like `queue --json`:
 * the tray reads from its server_time which queue lines are older than the action.
 */
export async function queuePause(ctx: Ctx, paused: boolean, o: { json: boolean } = { json: false }): Promise<number> {
  const q = await connectOperator(ctx).api.setPaused(paused);
  if (o.json) ctx.out(jsonLine(q));
  else ctx.out(paused ? (q.running ? 'the queue is paused: the running job finishes, no other job starts' : 'the queue is paused: no job starts') : 'the queue runs again');
  return 0;
}

/** Spec 06 3.1: pauses after failed reads; after 401/403 (a token that may get fixed) a longer one. */
export const WATCH_RETRY_MS = [1000, 2000, 5000, 10_000];
export const WATCH_AUTH_RETRY_MS = 60_000;
/** The long-poll of each read. */
export const WATCH_WAIT_S = 25;

export function watchErrorKind(e: unknown): 'network' | 'auth' | 'server' | null {
  if (e instanceof NetworkError) return 'network';
  if (e instanceof ApiError) return e.status === 401 || e.status === 403 ? 'auth' : 'server';
  return null;
}

/**
 * `fornax queue --watch [--json]`: the queue, then the queue again after every change, until the stop signal. A read
 * that fails prints an error (with --json a line `{"ok":false,"error","message"}`) and is tried again; the next good
 * read prints the queue even when it did not change. Each read has its own time limit, so a connection that died
 * without an error does not hang the watch.
 */
export async function queueWatch(
  ctx: Ctx,
  o: { json: boolean; retryMs?: number[]; authRetryMs?: number; waitS?: number; requestTimeoutMs?: number },
): Promise<number> {
  const { api, say } = connectOperator(ctx);
  const retry = o.retryMs ?? WATCH_RETRY_MS;
  const waitS = o.waitS ?? WATCH_WAIT_S;
  const limitMs = o.requestTimeoutMs ?? (waitS + 15) * 1000;
  let change: string | undefined;
  let failures = 0;
  while (!ctx.signal.aborted) {
    try {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(limitMs)]);
      const q = await api.operatorQueue({ wait: change === undefined ? 0 : waitS, change, signal });
      failures = 0;
      if (q.change === change) continue;
      change = q.change;
      if (o.json) {
        ctx.out(jsonLine(q));
      } else {
        ctx.out('');
        for (const line of renderQueue(q)) ctx.out(line);
      }
    } catch (e) {
      if (ctx.signal.aborted) break;
      const error = watchErrorKind(e);
      if (!error) throw e;
      const message = (e as Error).message;
      if (o.json) ctx.out(JSON.stringify({ ok: false, error, message }));
      else say(`cannot read the queue (${message}); trying again`);
      const delay = error === 'auth' ? (o.authRetryMs ?? WATCH_AUTH_RETRY_MS) : retry[Math.min(failures, retry.length - 1)]!;
      failures++;
      change = undefined;
      await sleep(delay, undefined, { signal: ctx.signal }).catch(() => undefined);
    }
  }
  return 0;
}
