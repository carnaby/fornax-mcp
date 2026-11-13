import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files, jobs, type Manifest } from '../db/schema.js';
import type { JobRow } from './jobs.js';
import { enqueueWebhook } from './webhooks.js';

export type Finish = { state: 'succeeded'; manifest: Manifest } | { state: 'failed'; error: string } | { state: 'canceled' };

/** The name of the log the worker uploaded for this job, if any. */
export function logName(db: Db, jobId: string): string | null {
  return db.select({ name: files.name }).from(files).where(and(eq(files.jobId, jobId), eq(files.kind, 'log'))).get()?.name ?? null;
}

/**
 * Every terminal transition goes through here: the final state, the finish time, a manifest of the same shape for
 * every final state (outputs only when succeeded), the lease ended, the webhook queued. Guarded by the state the caller saw: null when
 * the job moved meanwhile. A canceled job keeps its lease id, so the worker's next heartbeat still finds the job and
 * learns about the cancel.
 */
export function finishJob(db: Db, job: JobRow, finish: Finish, now: Date): JobRow | null {
  const manifest: Manifest = finish.state === 'succeeded' ? finish.manifest : { outputs: [], log: logName(db, job.id) };
  const row =
    db
      .update(jobs)
      .set({
        state: finish.state,
        error: finish.state === 'failed' ? finish.error : null,
        manifest,
        ...(finish.state === 'succeeded' ? { progress: 1 } : {}),
        ...(finish.state === 'canceled' ? {} : { leaseId: null }),
        leaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.state, job.state)))
      .returning()
      .get() ?? null;
  // Spec 5: after succeeded, failed or canceled the webhook is queued (when the job has a callback_url).
  if (row) enqueueWebhook(db, row, now);
  return row;
}
