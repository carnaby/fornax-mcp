import { z } from 'zod';
import { badRequest } from '../domain/errors.js';

export function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw badRequest(z.prettifyError(r.error));
  return r.data;
}
