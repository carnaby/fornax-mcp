import type { MoveTarget, OperatorJob, OperatorQueue } from '@fornax/protocol';
import { WorkerApi } from '../api.js';
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
    const notes = [j.type_unavailable ? 'type not offered' : '', j.run_after ? `retry at ${clock(j.run_after)}` : ''].filter(Boolean).join(', ');
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

/** `fornax queue pause` / `fornax queue resume`. */
export async function queuePause(ctx: Ctx, paused: boolean): Promise<number> {
  const q = await connectOperator(ctx).api.setPaused(paused);
  ctx.out(paused ? (q.running ? 'the queue is paused: the running job finishes, no other job starts' : 'the queue is paused: no job starts') : 'the queue runs again');
  return 0;
}
