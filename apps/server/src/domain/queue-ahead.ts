import { PRIORITIES, type Priority } from '@fornax/protocol';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs, jobTypes, tokens } from '../db/schema.js';
import { type JobRow, queuePosition } from './jobs.js';
import { IDLE } from './queue-order.js';
import { labelOf } from './who.js';

export const AHEAD_MAX = 20;
export type AheadJob = { position: number; type: string; agent: string | null; owner: string | null; label: string | null; priority: Priority; created_at: string };

/**
 * Spec 09 § 3.2: the jobs that can start, in queue order (as `position` counts them), at most AHEAD_MAX; with `job`, only
 * those before it, and null when it has no place (running, finished, idle, type not offered). No ids: another owner's
 * job cannot be acted on.
 */
export function jobsAhead(db: Db, job: JobRow | null): AheadJob[] | null {
  let limit = AHEAD_MAX;
  if (job) {
    const position = queuePosition(db, job);
    if (position === null) return null;
    limit = Math.min(AHEAD_MAX, position - 1);
    if (limit === 0) return [];
  }
  return db
    .select({ type: jobs.type, agent: jobs.agent, owner: tokens.name, params: jobs.params, priority: jobs.priority, createdAt: jobs.createdAt })
    .from(jobs)
    .innerJoin(jobTypes, and(eq(jobTypes.name, jobs.type), eq(jobTypes.offered, true)))
    .leftJoin(tokens, eq(tokens.id, jobs.ownerTokenId))
    .where(and(eq(jobs.state, 'queued'), ne(jobs.priority, IDLE)))
    .orderBy(asc(jobs.queueRank), asc(jobs.id))
    .limit(limit)
    .all()
    .map((r, i) => ({
      position: i + 1, type: r.type, agent: r.agent, owner: r.owner ?? null, label: labelOf(r.params),
      priority: PRIORITIES[r.priority] ?? 'normal', created_at: r.createdAt.toISOString(),
    }));
}
