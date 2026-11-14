import { z } from 'zod';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

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
