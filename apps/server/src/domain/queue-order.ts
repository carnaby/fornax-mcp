import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type JobState, jobs } from '../db/schema.js';
import { badRequest, conflict, notFound } from './errors.js';
import { jobChanges } from './signal.js';

/** Spec 06 2.3: where the operator moves a waiting job. */
export type MoveTarget = { to: 'top' | 'bottom' } | { before: string } | { after: string };

/** The waiting jobs with a place, in queue order. */
function waiting(db: Db): { id: string; priority: number }[] {
  return db
    .select({ id: jobs.id, priority: jobs.priority })
    .from(jobs)
    .where(and(eq(jobs.state, 'queued'), isNotNull(jobs.queueRank)))
    .orderBy(asc(jobs.queueRank), asc(jobs.id))
    .all();
}

/** Ranks 1..n in this order. */
function writeRanks(db: Db, ids: string[]): void {
  ids.forEach((id, i) => db.update(jobs).set({ queueRank: i + 1 }).where(eq(jobs.id, id)).run());
}

/** The ids of the waiting jobs, in the order the worker gets them (jobs of a withdrawn type included). */
export const queueOrder = (db: Db): string[] => waiting(db).map((j) => j.id);

/**
 * Spec 06 2.1: place a job that has just become queued. `priority` (a new job): right after the last waiting job of its
 * priority or higher, else at the top. `top` (a job that ran and came back): first. Call it inside the transaction that
 * queued the job; a job that is not queued (the caller's guarded update did not apply) is left alone.
 */
export function placeJob(db: Db, id: string, place: 'top' | 'priority'): void {
  const job = db.select({ state: jobs.state, priority: jobs.priority }).from(jobs).where(eq(jobs.id, id)).get();
  if (job?.state !== 'queued') return;
  const order = waiting(db).filter((j) => j.id !== id);
  let at = 0;
  if (place === 'priority') {
    for (let i = order.length - 1; i >= 0; i--) {
      if (order[i]!.priority >= job.priority) {
        at = i + 1;
        break;
      }
    }
  }
  order.splice(at, 0, { id, priority: job.priority });
  writeRanks(db, order.map((j) => j.id));
}

const notWaiting = (id: string, state: JobState): string =>
  `job ${id} is ${state === 'running' ? 'running now' : state}; only waiting jobs move`;

/** Spec 06 2.3: the operator moves a waiting job; 404 unknown job, 409 a job (or target) that does not wait, 400 itself. */
export function moveJob(db: Db, id: string, target: MoveTarget): void {
  db.transaction(() => {
    const job = db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw notFound(`job ${id} not found`);
    if (job.state !== 'queued') throw conflict(notWaiting(id, job.state));
    const order = queueOrder(db).filter((j) => j !== id);
    let at: number;
    if ('to' in target) {
      at = target.to === 'top' ? 0 : order.length;
    } else {
      const other = 'before' in target ? target.before : target.after;
      if (other === id) throw badRequest('a job cannot move before or after itself');
      const o = db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, other)).get();
      if (!o) throw notFound(`job ${other} not found`);
      const i = order.indexOf(other);
      if (o.state !== 'queued' || i < 0) throw conflict(notWaiting(other, o.state));
      at = 'before' in target ? i : i + 1;
    }
    order.splice(at, 0, id);
    writeRanks(db, order);
  });
  jobChanges.wake();
}

/**
 * Waiting jobs without a place (queued before 0.5.0, or anything that slipped through) get one at the end, in the order
 * the queue had before 0.5.0: priority, then age. Runs when the database is opened; returns how many it placed.
 */
export function repairQueueRanks(db: Db): number {
  const missing = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.state, 'queued'), isNull(jobs.queueRank)))
    .orderBy(desc(jobs.priority), asc(jobs.createdAt), asc(jobs.id))
    .all();
  if (!missing.length) return 0;
  db.transaction(() => writeRanks(db, [...queueOrder(db), ...missing.map((j) => j.id)]));
  return missing.length;
}
