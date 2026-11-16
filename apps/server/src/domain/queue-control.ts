import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { queueControl } from '../db/schema.js';
import { jobChanges, jobSignal } from './signal.js';

/** Spec 06 2.2: whether the operator paused the queue (no claim gets a job; the running one finishes). */
export function queuePaused(db: Db): boolean {
  return db.select({ paused: queueControl.paused }).from(queueControl).where(eq(queueControl.id, 1)).get()?.paused ?? false;
}

/** Since when the queue is paused; null while it runs. */
export function queuePausedAt(db: Db): Date | null {
  return db.select({ pausedAt: queueControl.pausedAt }).from(queueControl).where(eq(queueControl.id, 1)).get()?.pausedAt ?? null;
}

/** Pause or resume. Doing it twice changes nothing (a pause keeps its first time). Resuming wakes waiting claims. */
export function setQueuePaused(db: Db, paused: boolean, now: Date): void {
  if (queuePaused(db) === paused) return;
  const values = { paused, pausedAt: paused ? now : null };
  db.insert(queueControl).values({ id: 1, ...values }).onConflictDoUpdate({ target: queueControl.id, set: values }).run();
  jobSignal.wake();
  jobChanges.wake();
}
