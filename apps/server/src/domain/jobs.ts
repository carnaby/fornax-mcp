import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { JOB_STATES, PRIORITIES, type Priority, validateParams } from '@fornax/protocol';
import { and, count, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { files, type JobState, jobs, jobTypes } from '../db/schema.js';
import { conflict, notFound, tooMany, unprocessable } from './errors.js';
import { finishJob } from './finish.js';
import { getOfferedType, isOffered } from './job-types.js';
import { queuePaused } from './queue-control.js';
import { placeJob } from './queue-order.js';
import { jobChanges, jobSignal } from './signal.js';
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
  const given = input.inputs ?? {};
  for (const name of Object.keys(given)) if (!Object.hasOwn(contract.inputs, name)) throw unprocessable(`unknown input ${name}`);
  if (new Set(Object.values(given)).size !== Object.values(given).length) throw unprocessable('one file cannot be two inputs');

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
      if (file.jobId) throw conflict(`file ${id} is already the input of another job; upload it again`);
      if (!spec.extensions.includes(extname(file.name).toLowerCase())) throw unprocessable(`input ${name} must be one of ${spec.extensions.join(', ')}`);
      if (file.size > spec.max_mb * 1024 * 1024) throw unprocessable(`input ${name} is larger than ${spec.max_mb} MB`);
      inputs[name] = id;
    }
    const [open] = tx.select({ n: count() }).from(jobs).where(and(eq(jobs.ownerTokenId, owner), inArray(jobs.state, ['queued', 'running']))).all();
    if ((open?.n ?? 0) >= config.limits.maxQueuedPerToken) throw tooMany(`at most ${config.limits.maxQueuedPerToken} jobs may wait or run per token`);
    const row: JobRow = {
      id: ulid(now.getTime()), ownerTokenId: owner, type: contract.name, params: params.value, inputs,
      priority: PRIORITIES.indexOf(input.priority ?? 'normal'), group: input.group ?? null, callbackUrl: callbackHref,
      state: 'queued', attempts: 0, envReleases: 0, runAfter: now, leaseId: null, leaseExpiresAt: null, confirmedAt: null, progress: null, progressMessage: null,
      error: null, manifest: null, createdAt: now, startedAt: null, finishedAt: null, updatedAt: now,
      queueRank: null,
    };
    tx.insert(jobs).values(row).run();
    const ids = Object.values(inputs);
    if (ids.length) tx.update(files).set({ jobId: row.id }).where(inArray(files.id, ids)).run();
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
export function cancelJob(db: Db, owner: string, id: string, now: Date): JobRow {
  const job = getOwnJob(db, owner, id);
  if (job.state !== 'queued' && job.state !== 'running') throw conflict(`the job already ${job.state === 'succeeded' ? 'succeeded' : job.state}`);
  const row = finishJob(db, job, { state: 'canceled' }, now);
  if (!row) throw conflict('the job changed meanwhile; get its state again');
  return row;
}

/** 1-based place in the queue among jobs of offered types; null when not waiting or its type is withdrawn. */
export function queuePosition(db: Db, row: JobRow): number | null {
  if (row.state !== 'queued' || row.queueRank === null || !isOffered(db, row.type)) return null;
  const rank = row.queueRank;
  const ahead = db
    .select({ n: count() })
    .from(jobs)
    .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
    .where(and(eq(jobs.state, 'queued'), or(lt(jobs.queueRank, rank), and(eq(jobs.queueRank, rank), lt(jobs.id, row.id)))))
    .get();
  return (ahead?.n ?? 0) + 1;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

type Watched = {
  state: string; started_at: string | null; finished_at: string | null; position: number | null;
  progress: number | null; progress_message: string | null; attempts: number;
};

/** Spec 05a 5.1: 16 hex digits of a SHA-256 over what a waiting client watches; it changes exactly when one of them does. */
export function jobChange(v: Watched): string {
  const watched = [v.state, v.started_at, v.finished_at, v.position, v.progress, v.progress_message, v.attempts];
  return createHash('sha256').update(JSON.stringify(watched)).digest('hex').slice(0, 16);
}

export function jobView(db: Db, row: JobRow) {
  const view = {
    id: row.id,
    type: row.type,
    state: row.state,
    priority: PRIORITIES[row.priority] ?? 'normal',
    group: row.group,
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

/** "13:40 UTC": a time in a sentence does not depend on the server's time zone; exact times are in the fields. */
const hhmm = (d: Date): string => `${d.toISOString().slice(11, 16)} UTC`;
const AGAIN = 'asking again changes nothing';

/**
 * Spec 05a 5.2: one sentence, for a person and for an agent, why a queued job waits; null in every other state. The
 * first match wins: the worker is offline, the type is not offered, the worker waits for the card, else the queue.
 */
export function jobNote(db: Db, config: Config, row: JobRow, worker: WorkerView, now: Date): string | null {
  if (row.state !== 'queued') return null;
  if (!worker.online) {
    return worker.last_seen === null
      ? `waiting: the worker has not connected yet; the job starts when the worker runs, ${AGAIN}`
      : `waiting: the worker is offline since ${hhmm(new Date(worker.last_seen))}; the job starts when the worker runs again, ${AGAIN}`;
  }
  const position = queuePosition(db, row);
  if (position === null) {
    const days = Math.round(config.retention.unavailableTypeMs / 86_400_000);
    return `waiting: the worker does not offer the type ${row.type} now; the job starts when it is offered again, or fails after ${days} days without it`;
  }
  if (queuePaused(db)) return `waiting: the worker's operator paused the queue; the job waits until they resume it, ${AGAIN}`;
  if (worker.waiting) return worker.waiting.message;
  const retry = row.runAfter.getTime() > now.getTime() ? `; the next attempt starts at ${hhmm(row.runAfter)} at the earliest` : '';
  const running = db.select({ type: jobs.type, startedAt: jobs.startedAt }).from(jobs).where(eq(jobs.state, 'running')).get();
  if (running) return `waiting, position ${position}; running ${running.type} since ${hhmm(running.startedAt ?? now)}${retry}`;
  if (position === 1) return `waiting, position 1; the worker takes it next${retry}`;
  return `waiting, position ${position}; the worker takes the jobs ahead first${retry}`;
}

/** One job with the worker's state and the note (spec 05a 5.2): the answer to a submit and to a single job. */
export function jobDetail(db: Db, config: Config, row: JobRow, now: Date) {
  const worker = workerOnline(db, now);
  return { ...jobView(db, row), worker, note: jobNote(db, config, row, worker, now) };
}
