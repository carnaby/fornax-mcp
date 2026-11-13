import { randomUUID } from 'node:crypto';
import { type ClaimedJob, contractHash } from '@fornax/protocol';
import { and, asc, desc, eq, inArray, lt, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, type JobState, jobs, jobTypes } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import type { JobRow } from './jobs.js';
import { jobSignal } from './signal.js';

/** A worker holds a job this long without a heartbeat. */
export const LEASE_MS = 600_000;
export const MAX_ATTEMPTS = 3;
/** Wait before the next attempt after the n-th failed one: 1 minute, then 4. */
export const retryDelayMs = (attempts: number): number => 60_000 * 4 ** Math.max(0, attempts - 1);

export const LEASE_EXPIRED = 'the worker stopped answering (its lease ran out)';
export const LEASE_LOST = 'the job is no longer yours: it finished, was canceled, retried, or claimed again';

/** One line of at most 500 characters. */
function cleanError(raw: string): string {
  const line = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...(line || 'unknown error')].slice(0, 500).join('');
}

/**
 * Jobs whose worker stopped answering go back to the queue (lease id kept, so a worker that only slept can take the
 * job back with a heartbeat while nobody else claimed it) or fail after the last attempt (lease id cleared).
 */
export function expireLeases(db: Db, now: Date): number {
  const expired = db.select().from(jobs).where(and(eq(jobs.state, 'running'), lt(jobs.leaseExpiresAt, now))).all();
  db.transaction((tx) => {
    for (const j of expired) {
      const last = j.attempts >= MAX_ATTEMPTS;
      tx.update(jobs)
        .set(
          last
            ? { state: 'failed', error: LEASE_EXPIRED, leaseId: null, leaseExpiresAt: null, finishedAt: now, updatedAt: now }
            : { state: 'queued', error: LEASE_EXPIRED, leaseExpiresAt: null, runAfter: now, updatedAt: now },
        )
        .where(and(eq(jobs.id, j.id), eq(jobs.state, 'running')))
        .run();
    }
  });
  if (expired.length) jobSignal.wake();
  return expired.length;
}

/** The next due job of an offered type, under a fresh lease; null when there is none. */
export function claimJob(db: Db, now: Date): JobRow | null {
  expireLeases(db, now);
  return db.transaction((tx) => {
    const next = tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
      .where(and(eq(jobs.state, 'queued'), lte(jobs.runAfter, now)))
      .orderBy(desc(jobs.priority), asc(jobs.createdAt), asc(jobs.id))
      .limit(1)
      .get();
    if (!next) return null;
    const row = tx.select().from(jobs).where(eq(jobs.id, next.id)).get()!;
    return tx
      .update(jobs)
      .set({
        state: 'running', attempts: row.attempts + 1, leaseId: randomUUID(), leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        startedAt: now, progress: null, progressMessage: null, updatedAt: now,
      })
      .where(eq(jobs.id, next.id))
      .returning()
      .get()!;
  });
}

/** The job, if `lease` still holds it in one of `states`; 404 when it does not exist, 409 otherwise. */
export function ownedJob(db: Db, id: string, lease: string, states: JobState[] = ['running', 'queued']): JobRow {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw notFound(`job ${id} not found`);
  if (row.leaseId !== lease || !states.includes(row.state)) throw conflict(LEASE_LOST);
  return row;
}

export function heartbeatJob(
  db: Db, id: string, lease: string, input: { progress: number | null; message: string | null }, now: Date,
): { leaseUntil: Date | null; cancel: boolean } {
  return db.transaction(() => {
    const row = ownedJob(db, id, lease, ['running', 'queued', 'canceled']);
    if (row.state === 'canceled') return { leaseUntil: null, cancel: true };
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    db.update(jobs)
      .set({
        state: 'running', leaseExpiresAt: leaseUntil, error: null, updatedAt: now,
        ...(input.progress !== null ? { progress: input.progress } : {}),
        ...(input.message !== null ? { progressMessage: cleanError(input.message).slice(0, 200) } : {}),
      })
      .where(eq(jobs.id, id))
      .run();
    return { leaseUntil, cancel: false };
  });
}

/** A failed attempt: back to the queue after a back-off, or failed for good after the last attempt or when permanent. */
export function failJob(
  db: Db, id: string, lease: string, input: { error: string; permanent: boolean }, now: Date,
): { state: 'queued' | 'failed'; retryAt: Date | null } {
  const result = db.transaction(() => {
    const row = ownedJob(db, id, lease, ['running']);
    const final = input.permanent || row.attempts >= MAX_ATTEMPTS;
    const retryAt = final ? null : new Date(now.getTime() + retryDelayMs(row.attempts));
    db.update(jobs)
      .set({
        state: final ? 'failed' : 'queued', error: cleanError(input.error), leaseId: null, leaseExpiresAt: null,
        runAfter: retryAt ?? now, finishedAt: final ? now : null, updatedAt: now,
      })
      .where(eq(jobs.id, id))
      .run();
    return { state: final ? ('failed' as const) : ('queued' as const), retryAt };
  });
  if (result.state === 'queued') jobSignal.wake();
  return result;
}

/** The worker gives the job back without trying (stopping, or its environment is broken): the attempt does not count. */
export function releaseJob(db: Db, id: string, lease: string, now: Date): void {
  db.transaction(() => {
    const row = ownedJob(db, id, lease, ['running', 'queued']);
    db.update(jobs)
      .set({ state: 'queued', attempts: Math.max(row.attempts - 1, 0), leaseId: null, leaseExpiresAt: null, runAfter: now, startedAt: null, updatedAt: now })
      .where(eq(jobs.id, id))
      .run();
  });
  jobSignal.wake();
}

export function claimView(db: Db, row: JobRow): ClaimedJob {
  const ids = Object.values(row.inputs);
  const rows = ids.length ? db.select().from(files).where(inArray(files.id, ids)).all() : [];
  const type = db.select().from(jobTypes).where(eq(jobTypes.name, row.type)).get();
  return {
    id: row.id,
    lease: row.leaseId!,
    lease_until: row.leaseExpiresAt!.toISOString(),
    attempt: row.attempts,
    type: row.type,
    contract_hash: type ? contractHash(type.contract) : '',
    params: row.params,
    inputs: Object.entries(row.inputs).map(([name, id]) => {
      const f = rows.find((r) => r.id === id)!;
      return { name, file_name: f.name, size: f.size, sha256: f.sha256 };
    }),
  };
}
