import { createHash } from 'node:crypto';
import { z } from 'zod';
import { paramSchema } from './params-schema.js';

export const TYPE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const INPUT_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export const jobInputSpec = z.strictObject({
  extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/)).min(1).max(50),
  max_mb: z.number().int().min(1).max(100_000),
  required: z.boolean().default(true),
});

/** The public part of a type pack: what the worker announces and clients see. The command never leaves the worker. */
export const jobTypeContract = z.strictObject({
  name: z.string().regex(TYPE_NAME),
  version: z.number().int().min(1),
  description: z.string().min(1).max(500),
  inputs: z.record(z.string().regex(INPUT_NAME), jobInputSpec).default({}),
  params: paramSchema,
  max_runtime_s: z.number().int().min(1).max(7 * 86_400),
});

export type JobTypeContract = z.infer<typeof jobTypeContract>;

/** JSON with object keys sorted at every level: equal values give equal strings. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const contractHash = (c: JobTypeContract): string => createHash('sha256').update(canonicalJson(c)).digest('hex');
