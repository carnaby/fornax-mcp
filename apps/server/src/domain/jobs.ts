import { extname } from 'node:path';
import { validateParams } from '@fornax/protocol';
import { and, count, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { files, type JobState, jobs, jobTypes } from '../db/schema.js';
import { conflict, notFound, tooMany, unprocessable } from './errors.js';
import { getOfferedType, isOffered } from './job-types.js';
import { jobSignal } from './signal.js';

export type JobRow = typeof jobs.$inferSelect;
export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const GROUP = /^[A-Za-z0-9._-]{1,100}$/;

export type SubmitInput = {
  type: string;
  params?: unknown;
  inputs?: Record<string, string>;
  priority?: Priority;
  group?: string | null;
  callback_url?: string | null;
};

/** The URL is allowed when its normalized form starts with one of the configured prefixes. */
export function callbackAllowed(url: string, prefixes: string[]): boolean {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return false;
  }
  return prefixes.some((p) => href.startsWith(new URL(p).href));
}

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
      state: 'queued', attempts: 0, runAfter: now, leaseId: null, leaseExpiresAt: null, confirmedAt: null, progress: null, progressMessage: null,
      error: null, manifest: null, createdAt: now, startedAt: null, finishedAt: null, updatedAt: now,
    };
    tx.insert(jobs).values(row).run();
    const ids = Object.values(inputs);
    if (ids.length) tx.update(files).set({ jobId: row.id }).where(inArray(files.id, ids)).run();
    jobSignal.wake();
    return row;
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
  return db
    .update(jobs)
    .set({ state: 'canceled', finishedAt: now, updatedAt: now, leaseExpiresAt: null })
    .where(and(eq(jobs.id, id), inArray(jobs.state, ['queued', 'running'])))
    .returning()
    .get()!;
}

/** 1-based place in the queue among jobs of offered types; null when not waiting or its type is withdrawn. */
export function queuePosition(db: Db, row: JobRow): number | null {
  if (row.state !== 'queued' || !isOffered(db, row.type)) return null;
  const ahead = db
    .select({ n: count() })
    .from(jobs)
    .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
    .where(
      and(
        eq(jobs.state, 'queued'),
        or(gt(jobs.priority, row.priority), and(eq(jobs.priority, row.priority), lt(jobs.createdAt, row.createdAt)), and(eq(jobs.priority, row.priority), eq(jobs.createdAt, row.createdAt), lt(jobs.id, row.id))),
      ),
    )
    .get();
  return (ahead?.n ?? 0) + 1;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function jobView(db: Db, row: JobRow) {
  return {
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
}
