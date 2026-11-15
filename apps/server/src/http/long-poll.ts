import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_JOB_WAIT_S, waitForJobChange } from '../domain/job-wait.js';

/** `?wait=<seconds>&change=<hash>` of a long-poll (spec 05a 5.1, spec 06 2.3). */
export const waitQuery = z.object({
  wait: z.coerce.number().int().min(0).max(MAX_JOB_WAIT_S).optional(),
  change: z.string().max(64).optional(),
});

/**
 * What `read` gives: at once without `wait`; with it, when its change differs from `change`, at the latest after `wait`
 * seconds. `closing` is the route plugin's own signal that aborts when the server closes.
 */
export async function answerWhenChanged<T extends { change: string }>(
  req: FastifyRequest, reply: FastifyReply, closing: AbortSignal, read: () => T, q: { wait?: number; change?: string },
): Promise<T> {
  if (!q.wait) return read();
  const stop = new AbortController();
  const hangUp = () => stop.abort();
  // A client that hangs up (or a server that closes) ends the wait: no timer stays behind.
  reply.raw.on('close', hangUp);
  closing.addEventListener('abort', hangUp, { once: true });
  if (req.raw.socket?.destroyed === true || closing.aborted) stop.abort();
  try {
    return await waitForJobChange(read, q.change, q.wait * 1000, stop.signal);
  } finally {
    reply.raw.off('close', hangUp);
    closing.removeEventListener('abort', hangUp);
  }
}
