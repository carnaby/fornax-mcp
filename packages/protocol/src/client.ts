import { z } from 'zod';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
/** Spec 07 § 2.1: the stored value is the index (idle 0, normal 1, high 2). An idle job never starts by itself. */
export const PRIORITIES = ['idle', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];
/** What a client may send: `low` (before 0.9.0) is taken as `normal`. */
export const PRIORITY_INPUTS = ['idle', 'normal', 'high', 'low'] as const;
export const priorityInput = z.enum(PRIORITY_INPUTS).transform((p): Priority => (p === 'low' ? 'normal' : p));

/** The fields of a job answer (POST /api/jobs, GET /api/jobs/:id) that fornax lease relies on; the server sends more. */
export const clientJobView = z.object({
  id: z.string(),
  type: z.string(),
  state: z.enum(JOB_STATES),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  position: z.number().int().nullable(),
  error: z.string().nullable(),
  change: z.string(),
  /** Only in answers about one job (spec 05a 5.2). */
  note: z.string().nullable().optional(),
});
export type ClientJobView = z.infer<typeof clientJobView>;
