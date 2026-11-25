import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { AGENT_RULE, agentProblem, defaultPriority, JOB_STATES, PRIORITIES, type Priority, validateParams } from '@fornax/protocol';
import { and, count, desc, eq, inArray, lt, ne, or } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { files, jobInputs, type JobState, jobs, jobTypes } from '../db/schema.js';
import { conflict, notFound, tooMany, unprocessable } from './errors.js';
import { finishJob } from './finish.js';
import { getOfferedType, isOffered } from './job-types.js';
import { queuePaused } from './queue-control.js';
import { IDLE, placeJob } from './queue-order.js';
import { jobChanges, jobSignal } from './signal.js';
import { timeText } from './time-text.js';
import { runningText } from './who.js';
import { callbackAllowed } from './webhooks.js';
import { workerOnline, type WorkerView } from './worker-state.js';

export { callbackAllowed };
export { JOB_STATES, PRIORITIES, type Priority };

export type JobRow = typeof jobs.$inferSelect;
export const GROUP = /^[A-Za-z0-9._-]{1,100}$/;

export type SubmitInput = {
  type: string;
  params?: unknown;
  inputs?: Record<string, string>;
  priority?: Priority;
  group?: string | null;
  callback_url?: string | null;
  /** Spec 09 § 2.3: who submits it; '' is none. */
  agent?: string | null;
};

export function submitJob(db: Db, config: Config, owner: string, input: SubmitInput, now: Date): JobRow {
  const contract = getOfferedType(db, input.type);
  if (!contract) throw unprocessable(`job type ${input.type} is not offered now; list_job_types shows what is`);
  const params = validateParams(contract.params, input.params ?? {});
  if (!params.ok) throw unprocessable(`invalid params: ${params.errors.join('; ')}`);
  if (input.group != null && !GROUP.test(input.group)) throw unprocessable('group must be 1-100 characters A-Z, a-z, 0-9, ".", "_" or "-"');
  if (input.callback_url != null && !callbackAllowed(input.callback_url, config.webhooks.allowedPrefixes)) {
    throw unprocessable('callback_url is not allowed on this server');
  }
  const callbackHref = input.callback_url == null ? null : new URL(input.callback_url).href;
  // Spec 09 § 2.2: an empty name is no agent.
  const agent = input.agent ? input.agent : null;
  if (agent !== null && agentProblem(agent)) throw unprocessable(`agent ${AGENT_RULE}`);
  const given = input.inputs ?? {};
  for (const name of Object.keys(given)) if (!Object.hasOwn(contract.inputs, name)) throw unprocessable(`unknown input ${name}`);
  if (new Set(Object.values(given)).size !== Object.values(given).length) throw unprocessable('one file cannot be two inputs');

  // Spec 07 § 4.4: without a priority the type decides.
  const priority = input.priority ?? defaultPriority(contract);

  return db.transaction((tx) => {
    const inputs: Record<string, string> = {};
    for (const [name, spec] of Object.entries(contract.inputs)) {
      const id = given[name];
      if (!id) {
        if (spec.required) throw unprocessable(`input ${name} is required`);
        continue;
      }
      const file = tx.select().from(files).where(and(eq(files.id, id), eq(files.ownerTokenId, owner), eq(files.kind, 'input'))).get();
      if (!file) throw notFound(`file ${id} not found`);
      if (!spec.extensions.includes(extname(file.name).toLowerCase())) throw unprocessable(`input ${name} must be one of ${spec.extensions.join(', ')}`);
      if (file.size > spec.max_mb * 1024 * 1024) throw unprocessable(`input ${name} is larger than ${spec.max_mb} MB`);
      inputs[name] = id;
    }
    const [open] = tx.select({ n: count() }).from(jobs).where(and(eq(jobs.ownerTokenId, owner), inArray(jobs.state, ['queued', 'running']))).all();
    if ((open?.n ?? 0) >= config.limits.maxQueuedPerToken) throw tooMany(`at most ${config.limits.maxQueuedPerToken} jobs may wait or run per token`);
    const row: JobRow = {
      id: ulid(now.getTime()), ownerTokenId: owner, type: contract.name, params: params.value, inputs,
      priority: PRIORITIES.indexOf(priority), group: input.group ?? null, callbackUrl: callbackHref,
      state: 'queued', attempts: 0, envReleases: 0, runAfter: now, leaseId: null, leaseExpiresAt: null, confirmedAt: null, progress: null, progressMessage: null,
      error: null, manifest: null, createdAt: now, startedAt: null, finishedAt: null, updatedAt: now,
      queueRank: null, stoppedLeaseId: null, idleSince: priority === 'idle' ? now : null, agent,
    };
    tx.insert(jobs).values(row).run();
    const ids = Object.values(inputs);
    if (ids.length) tx.insert(jobInputs).values(ids.map((fileId) => ({ jobId: row.id, fileId }))).run();
    // Spec 06 2.1.2: a new job's place follows its priority; the answer carries it.
    placeJob(db, row.id, 'priority');
    jobSignal.wake();
    jobChanges.wake();
    return tx.select().from(jobs).where(eq(jobs.id, row.id)).get()!;
  });
}

export function listJobs(db: Db, owner: string, filter: { state?: JobState; group?: string; limit: number }): JobRow[] {
  const where = [eq(jobs.ownerTokenId, owner)];
  if (filter.state) where.push(eq(jobs.state, filter.state));
  if (filter.group) where.push(eq(jobs.group, filter.group));
  return db.select().from(jobs).where(and(...where)).orderBy(desc(jobs.createdAt)).limit(filter.limit).all();
}

export function getOwnJob(db: Db, owner: string, id: string): JobRow {
  const row = db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.ownerTokenId, owner))).get();
  if (!row) throw notFound(`job ${id} not found`);
  return row;
}

/** Queued: canceled at once. Running: canceled now; the worker learns it at its next heartbeat and stops the process. */
function cancelRow(db: Db, job: JobRow, now: Date): JobRow {
  if (job.state !== 'queued' && job.state !== 'running') throw conflict(`the job already ${job.state === 'succeeded' ? 'succeeded' : job.state}`);
  const row = finishJob(db, job, { state: 'canceled' }, now);
  if (!row) throw conflict('the job changed meanwhile; get its state again');
  return row;
}

export function cancelJob(db: Db, owner: string, id: string, now: Date): JobRow {
  return cancelRow(db, getOwnJob(db, owner, id), now);
}

/** Spec 06 2.3: the operator cancels a job of any owner, the same way. */
export function cancelAnyJob(db: Db, id: string, now: Date): JobRow {
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw notFound(`job ${id} not found`);
  return cancelRow(db, job, now);
}

/** 1-based place among the jobs of offered types that can start; null when not waiting, idle, or its type is withdrawn. */
export function queuePosition(db: Db, row: JobRow): number | null {
  if (row.state !== 'queued' || row.queueRank === null || row.priority === IDLE || !isOffered(db, row.type)) return null;
  const rank = row.queueRank;
  const ahead = db
    .select({ n: count() })
    .from(jobs)
    .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
    .where(and(eq(jobs.state, 'queued'), ne(jobs.priority, IDLE), or(lt(jobs.queueRank, rank), and(eq(jobs.queueRank, rank), lt(jobs.id, row.id)))))
    .get();
  return (ahead?.n ?? 0) + 1;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

type Watched = {
  state: string; priority: string; started_at: string | null; finished_at: string | null; position: number | null;
  progress: number | null; progress_message: string | null; attempts: number;
};

/** Spec 05a 5.1: 16 hex digits of a SHA-256 over what a waiting client watches; it changes exactly when one of them does. */
export function jobChange(v: Watched): string {
  const watched = [v.state, v.priority, v.started_at, v.finished_at, v.position, v.progress, v.progress_message, v.attempts];
  return createHash('sha256').update(JSON.stringify(watched)).digest('hex').slice(0, 16);
}

export function jobView(db: Db, row: JobRow) {
  const view = {
    id: row.id,
    type: row.type,
    state: row.state,
    priority: PRIORITIES[row.priority] ?? 'normal',
    group: row.group,
    agent: row.agent,
    params: row.params,
    inputs: row.inputs,
    attempts: row.attempts,
    progress: row.progress,
    progress_message: row.progressMessage,
    error: row.error,
    type_unavailable: row.state === 'queued' && !isOffered(db, row.type),
    position: queuePosition(db, row),
    outputs: row.manifest?.outputs.map(({ file_id: _id, ...o }) => o) ?? null,
    log: row.manifest?.log ?? null,
    created_at: row.createdAt.toISOString(),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
  };
  return { ...view, change: jobChange(view) };
}

/** Spec 07 § 2.2. */
export const IDLE_NOTE = 'this job is idle: it waits until the operator starts it or its owner changes its priority';
/** Spec 07 § 4.1: the answer to a submit that made an idle job. */
export const IDLE_WARNING = 'this job waits until the operator starts it; pass priority normal to run it automatically';

/** "Blender 5.2.2 LTS, Cycles on …" → 5, 2 and " LTS"-like rest up to the first comma (spec 14 § 3.2). */
const BLENDER_ENV = /^Blender (\d+)\.(\d+)([^,]*)/;

/** Spec 14 § 3.2: an input saved by a newer Blender than the type's environment names. */
function blendWarnings(db: Db, row: JobRow): string[] {
  const env = db.select({ environment: jobTypes.environment }).from(jobTypes).where(eq(jobTypes.name, row.type)).get()?.environment;
  const m = env ? BLENDER_ENV.exec(env) : null;
  if (!m) return [];
  const worker = [Number(m[1]), Number(m[2])] as const;
  const warnings: string[] = [];
  for (const [name, id] of Object.entries(row.inputs)) {
    const saved = db.select({ meta: files.meta }).from(files).where(eq(files.id, id)).get()?.meta?.blender;
    if (typeof saved !== 'string') continue;
    const [major, minor] = saved.split('.').map(Number) as [number, number];
    if (major > worker[0] || (major === worker[0] && minor > worker[1])) {
      warnings.push(`${name} was saved by Blender ${saved}; the worker runs Blender ${m[1]}.${m[2]}${m[3]}, which may lose data: save it with Blender ${m[1]}.${m[2]} or older.`);
    }
  }
  return warnings;
}

/** Spec 07 § 4.1 and spec 14 § 3.2: what a submit answers as warning (idle first, then the inputs), joined with "; ". */
export function submitWarning(db: Db, row: JobRow): string | null {
  const all = [...(row.priority === IDLE ? [IDLE_WARNING] : []), ...blendWarnings(db, row)];
  return all.length ? all.join('; ') : null;
}

const AGAIN = 'asking again changes nothing';

/**
 * Spec 05a 5.2: one sentence, for a person and for an agent, why a queued job waits; null in every other state. The
 * first match wins: the job is idle (spec 07 § 2.2), the worker is offline, the type is not offered, the worker waits for
 * the card, else the queue.
 */
export function jobNote(db: Db, config: Config, row: JobRow, worker: WorkerView, now: Date): string | null {
  if (row.state !== 'queued') return null;
  // Spec 09 § 4: times in the server's zone; exact times are in the fields.
  const at = (d: Date) => timeText(d, now, config.timeZone);
  if (row.priority === IDLE && isOffered(db, row.type)) return IDLE_NOTE;
  if (!worker.online) {
    return worker.last_seen === null
      ? `waiting: the worker has not connected yet; the job starts when the worker runs, ${AGAIN}`
      : `waiting: the worker is offline since ${at(new Date(worker.last_seen))}; the job starts when the worker runs again, ${AGAIN}`;
  }
  const position = queuePosition(db, row);
  if (position === null) {
    const days = Math.round(config.retention.unavailableTypeMs / 86_400_000);
    return `waiting: the worker does not offer the type ${row.type} now; the job starts when it is offered again, or fails after ${days} days without it`;
  }
  if (queuePaused(db)) return `waiting: the worker's operator paused the queue; the job waits until they resume it, ${AGAIN}`;
  if (worker.waiting) return worker.waiting.message;
  const retry = row.runAfter.getTime() > now.getTime() ? `; the next attempt starts at ${at(row.runAfter)} at the earliest` : '';
  const running = db
    .select({ type: jobs.type, params: jobs.params, agent: jobs.agent, ownerTokenId: jobs.ownerTokenId, startedAt: jobs.startedAt })
    .from(jobs).where(eq(jobs.state, 'running')).get();
  if (running) return `waiting, position ${position}; ${runningText(db, running, now, config.timeZone)}${retry}`;
  if (position === 1) return `waiting, position 1; the worker takes it next${retry}`;
  return `waiting, position ${position}; the worker takes the jobs ahead first${retry}`;
}

/** One job with the worker's state and the note (spec 05a 5.2): the answer to a submit and to a single job. */
export function jobDetail(db: Db, config: Config, row: JobRow, now: Date) {
  const worker = workerOnline(db, now);
  return { ...jobView(db, row), worker, note: jobNote(db, config, row, worker, now) };
}
