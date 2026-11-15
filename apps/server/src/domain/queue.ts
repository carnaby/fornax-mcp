import { randomUUID } from 'node:crypto';
import { type ClaimedJob, contractHash, LEASE_MS, type ReleaseReason } from '@fornax/protocol';
import { and, asc, eq, inArray, isNull, lt, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, type JobState, jobs, jobTypes, tokens } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import { finishJob } from './finish.js';
import { isOffered } from './job-types.js';
import type { JobRow } from './jobs.js';
import { placeJob } from './queue-order.js';
import { jobChanges, jobSignal } from './signal.js';

export { LEASE_MS };
export const MAX_ATTEMPTS = 3;
/** Wait before the next attempt after the n-th failed one: 1 minute, then 4. */
export const retryDelayMs = (attempts: number): number => 60_000 * 4 ** Math.max(0, attempts - 1);

export const LEASE_EXPIRED = 'the worker stopped answering (its lease ran out)';
export const LEASE_LOST = 'the job is no longer yours: it finished, was canceled, retried, or claimed again';
export const ABANDONED = 'the worker asked for a new job while this one was still running (it restarted or lost the connection)';

/** One line of at most `max` characters, without control characters; null when nothing is left. */
export function oneLine(raw: string, max: number): string | null {
  const line = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? [...line].slice(0, max).join('') : null;
}

const cleanError = (raw: string): string => oneLine(raw, 500) ?? 'unknown error';

/**
 * Jobs whose worker stopped answering go back to the queue (lease id kept, so a worker that only slept can take the
 * job back with a heartbeat while nobody else claimed it) or fail after the last attempt (lease id cleared).
 */
export function expireLeases(db: Db, now: Date): number {
  const expired = db.select().from(jobs).where(and(eq(jobs.state, 'running'), lt(jobs.leaseExpiresAt, now))).all();
  db.transaction(() => {
    for (const j of expired) {
      if (j.attempts >= MAX_ATTEMPTS) {
        finishJob(db, j, { state: 'failed', error: LEASE_EXPIRED }, now);
        continue;
      }
      db.update(jobs)
        .set({ state: 'queued', error: LEASE_EXPIRED, leaseExpiresAt: null, runAfter: now, updatedAt: now })
        .where(and(eq(jobs.id, j.id), eq(jobs.state, 'running')))
        .run();
      placeJob(db, j.id, 'top');
    }
  });
  if (expired.length) {
    jobSignal.wake();
    jobChanges.wake();
  }
  return expired.length;
}

/**
 * One worker runs one job at a time, so a claim while a job is still `running` means that job was abandoned: the
 * answer to its claim was lost (PC asleep, Wi-Fi drop) or the worker restarted. Lapsed leases expire first, as
 * always; every other running job goes back to the queue at once. A job the worker never confirmed gets its
 * attempt back; a confirmed one counts it, and fails after the last attempt, like an expired lease.
 */
export function abandonRunning(db: Db, now: Date): number {
  expireLeases(db, now);
  const running = db.select().from(jobs).where(eq(jobs.state, 'running')).all();
  if (!running.length) return 0;
  db.transaction(() => {
    for (const j of running) {
      const confirmed = j.confirmedAt !== null;
      if (confirmed && j.attempts >= MAX_ATTEMPTS) {
        finishJob(db, j, { state: 'failed', error: ABANDONED }, now);
        continue;
      }
      const values = confirmed
        ? { state: 'queued' as const, error: ABANDONED }
        : { state: 'queued' as const, attempts: Math.max(j.attempts - 1, 0), error: null, startedAt: null };
      db.update(jobs)
        .set({ ...values, leaseId: null, leaseExpiresAt: null, confirmedAt: null, runAfter: now, updatedAt: now })
        .where(and(eq(jobs.id, j.id), eq(jobs.state, 'running')))
        .run();
      placeJob(db, j.id, 'top');
    }
  });
  jobSignal.wake();
  jobChanges.wake();
  return running.length;
}

/** The next due job of an offered type, under a fresh lease; null when there is none. */
export function claimJob(db: Db, now: Date): JobRow | null {
  expireLeases(db, now);
  const row = db.transaction((tx) => {
    const next = tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
      // A job of a token that is no longer active (revoked) is never run.
      .innerJoin(tokens, and(eq(tokens.id, jobs.ownerTokenId), eq(tokens.status, 'active')))
      .where(and(eq(jobs.state, 'queued'), lte(jobs.runAfter, now)))
      .orderBy(asc(jobs.queueRank), asc(jobs.id))
      .limit(1)
      .get();
    if (!next) return null;
    const row = tx.select().from(jobs).where(eq(jobs.id, next.id)).get()!;
    return tx
      .update(jobs)
      .set({
        state: 'running', attempts: row.attempts + 1, leaseId: randomUUID(), leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        confirmedAt: null, startedAt: now, progress: null, progressMessage: null, error: null, updatedAt: now,
      })
      .where(eq(jobs.id, next.id))
      .returning()
      .get()!;
  });
  if (row) jobChanges.wake();
  return row;
}

/** The worker has shown it holds the job (first heartbeat or input download). */
export function confirmJob(db: Db, id: string, now: Date): void {
  db.update(jobs).set({ confirmedAt: now }).where(and(eq(jobs.id, id), isNull(jobs.confirmedAt))).run();
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
  const r = db.transaction(() => {
    const row = ownedJob(db, id, lease, ['running', 'queued', 'canceled']);
    if (row.state === 'canceled') return { leaseUntil: null, cancel: true };
    // A late heartbeat may take an expired job back, but not one whose type the worker no longer offers.
    if (row.state === 'queued' && !isOffered(db, row.type)) throw conflict(LEASE_LOST);
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    db.update(jobs)
      .set({
        state: 'running', leaseExpiresAt: leaseUntil, error: null, confirmedAt: row.confirmedAt ?? now, updatedAt: now,
        ...(input.progress !== null ? { progress: input.progress } : {}),
        // An empty message clears the text; null leaves it as it was.
        ...(input.message !== null ? { progressMessage: oneLine(input.message, 200) } : {}),
      })
      .where(eq(jobs.id, id))
      .run();
    return { leaseUntil, cancel: false };
  });
  jobChanges.wake();
  return r;
}

/** A failed attempt: back to the queue after a back-off, or failed for good after the last attempt or when permanent. */
export function failJob(
  db: Db, id: string, lease: string, input: { error: string; permanent: boolean }, now: Date,
): { state: 'queued' | 'failed'; retryAt: Date | null } {
  const result = db.transaction(() => {
    const row = ownedJob(db, id, lease, ['running']);
    const error = cleanError(input.error);
    if (input.permanent || row.attempts >= MAX_ATTEMPTS) {
      finishJob(db, row, { state: 'failed', error }, now);
      return { state: 'failed' as const, retryAt: null };
    }
    const retryAt = new Date(now.getTime() + retryDelayMs(row.attempts));
    db.update(jobs)
      .set({ state: 'queued', error, leaseId: null, leaseExpiresAt: null, runAfter: retryAt, finishedAt: null, updatedAt: now })
      .where(eq(jobs.id, id))
      .run();
    placeJob(db, id, 'top');
    return { state: 'queued' as const, retryAt };
  });
  if (result.state === 'queued') jobSignal.wake();
  jobChanges.wake();
  return result;
}

export const ENVIRONMENT_AGAIN = 'the tool reported a broken environment again for this job';

/**
 * The worker gives the job back without trying: it is stopping, or the type's environment is broken (exit code 3).
 * Neither counts an attempt, except a second environment release of the same job: a job that breaks the tool every
 * time must not keep its type offline forever, so that one is a failed attempt (retried later, failed after the last).
 */
export function releaseJob(db: Db, id: string, lease: string, now: Date, reason: ReleaseReason = 'stopping'): 'queued' | 'failed' {
  const again = db.transaction(() => {
    const row = ownedJob(db, id, lease, ['running', 'queued']);
    if (reason === 'environment' && row.envReleases >= 1 && row.state === 'running') return true;
    db.update(jobs)
      .set({
        state: 'queued', attempts: Math.max(row.attempts - 1, 0), envReleases: row.envReleases + (reason === 'environment' ? 1 : 0),
        leaseId: null, leaseExpiresAt: null, runAfter: now, startedAt: null, updatedAt: now,
      })
      .where(eq(jobs.id, id))
      .run();
    placeJob(db, id, 'top');
    return false;
  });
  if (again) return failJob(db, id, lease, { error: ENVIRONMENT_AGAIN, permanent: false }, now).state;
  jobSignal.wake();
  jobChanges.wake();
  return 'queued';
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
