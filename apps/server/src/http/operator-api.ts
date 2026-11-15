import { moveBody, pauseBody } from '@fornax/protocol';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { cancelAnyJob } from '../domain/jobs.js';
import { MAX_JOB_WAIT_S, waitForJobChange } from '../domain/job-wait.js';
import { operatorQueue } from '../domain/operator.js';
import { setQueuePaused } from '../domain/queue-control.js';
import { moveJob } from '../domain/queue-order.js';
import type { RouteDeps } from './deps.js';
import { resultUrl } from './links.js';
import { parse } from './parse.js';

const query = z.object({
  wait: z.coerce.number().int().min(0).max(MAX_JOB_WAIT_S).optional(),
  change: z.string().max(64).optional(),
});

/**
 * Spec 06 2.3: the operator's view and control of the whole queue, under /api/worker with the worker token. Registered
 * inside workerRoutes, so it inherits the token check. Every route is quiet: the tray asks while the worker is stopped,
 * which must not make the worker look online.
 */
export const operatorRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  // On shutdown waiting requests answer at once instead of holding the close up.
  const closing = new AbortController();
  app.addHook('preClose', async () => closing.abort());
  const view = () => operatorQueue(deps.db, deps.clock(), (job) => resultUrl(deps, job));

  app.get('/jobs', { config: { quiet: true } }, async (req, reply) => {
    const q = parse(query, req.query);
    if (!q.wait) return view();
    const stop = new AbortController();
    const hangUp = () => stop.abort();
    reply.raw.on('close', hangUp);
    closing.signal.addEventListener('abort', hangUp, { once: true });
    if (req.raw.socket?.destroyed === true || closing.signal.aborted) stop.abort();
    try {
      return await waitForJobChange(view, q.change, q.wait * 1000, stop.signal);
    } finally {
      reply.raw.off('close', hangUp);
      closing.signal.removeEventListener('abort', hangUp);
    }
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/move', { config: { quiet: true } }, async (req) => {
    moveJob(deps.db, req.params.id, parse(moveBody, req.body));
    return view();
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', { config: { quiet: true } }, async (req) => {
    cancelAnyJob(deps.db, req.params.id, deps.clock());
    return view();
  });

  app.put('/pause', { config: { quiet: true } }, async (req) => {
    setQueuePaused(deps.db, parse(pauseBody, req.body).paused, deps.clock());
    return view();
  });
};
