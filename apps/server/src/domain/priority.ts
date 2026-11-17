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
