import { PRIORITIES, type Priority } from '@fornax/protocol';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import type { JobRow } from './jobs.js';
import { IDLE, placeJob } from './queue-order.js';
import { jobChanges, jobSignal } from './signal.js';

const NORMAL = PRIORITIES.indexOf('normal');

/** A job by id; with `owner` only that owner's (another owner's job is as unknown as a missing one). */
export function findJob(db: Db, id: string, owner: string | null): JobRow {
  const where = owner === null ? eq(jobs.id, id) : and(eq(jobs.id, id), eq(jobs.ownerTokenId, owner));
  const row = db.select().from(jobs).where(where).get();
  if (!row) throw notFound(`job ${id} not found`);
  return row;
}

/** Spec 07 § 2.3: a waiting job gets a new priority and is placed as if it were new; the same priority changes nothing. */
export function setJobPriority(db: Db, id: string, priority: Priority, now: Date, owner: string | null): JobRow {
  const value = PRIORITIES.indexOf(priority);
  const changed = db.transaction(() => {
    const job = findJob(db, id, owner);
    if (job.state !== 'queued') {
      throw conflict(`job ${id} is ${job.state === 'running' ? 'running now' : job.state}; only a waiting job changes its priority`);
    }
    if (job.priority === value) return false;
    db.update(jobs).set({ priority: value, idleSince: value === IDLE ? now : null, updatedAt: now }).where(eq(jobs.id, id)).run();
    placeJob(db, id, 'priority');
    return true;
  });
  if (changed) {
    jobSignal.wake();
    jobChanges.wake();
  }
  return findJob(db, id, null);
}

/** Spec 07 § 2.3, Start all: every idle job becomes normal, at the end of the normal ones, keeping their order. */
export function startIdle(db: Db, now: Date): number {
  const started = db.transaction(() => {
    const idle = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.state, 'queued'), eq(jobs.priority, IDLE)))
      .orderBy(asc(jobs.queueRank), asc(jobs.id))
      .all();
    for (const { id } of idle) {
      db.update(jobs).set({ priority: NORMAL, idleSince: null, updatedAt: now }).where(eq(jobs.id, id)).run();
      placeJob(db, id, 'priority');
    }
    return idle.length;
  });
  if (started) {
    jobSignal.wake();
    jobChanges.wake();
  }
  return started;
}

/** The type of leases: a program of an agent, not a job that can start again (it is revoked instead). */
const LEASE_TYPE = 'lease';
export const LEASE_REQUEUE = 'a lease cannot go back to the queue; revoke it instead';
const notRunning = (id: string, state: string) => `job ${id} is ${state}; only a running job can go back to the queue`;

/**
 * Spec 07 § 3.1: a running job goes back to the queue at once (Pause: as idle). Its lease is kept as
 * `stopped_lease_id`, so the worker's next heartbeat is told to stop (cancel + requeued); the run is not an attempt.
 */
export function requeueJob(db: Db, id: string, o: { idle: boolean }, now: Date, owner: string | null): JobRow {
  db.transaction(() => {
    const job = findJob(db, id, owner);
    if (job.state !== 'running') throw conflict(notRunning(id, job.state));
    if (job.type === LEASE_TYPE) throw conflict(LEASE_REQUEUE);
    db.update(jobs)
      .set({
        state: 'queued', stoppedLeaseId: job.leaseId, leaseId: null, leaseExpiresAt: null, confirmedAt: null, startedAt: null,
        progress: null, progressMessage: null, runAfter: now, attempts: Math.max(job.attempts - 1, 0), error: null, updatedAt: now,
        ...(o.idle ? { priority: IDLE, idleSince: now } : {}),
      })
      .where(and(eq(jobs.id, id), eq(jobs.state, 'running')))
      .run();
    placeJob(db, id, 'class-top');
  });
  jobSignal.wake();
  jobChanges.wake();
  return findJob(db, id, null);
}
