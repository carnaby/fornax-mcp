import { moveBody, pauseBody } from '@fornax/protocol';
import type { FastifyPluginAsync } from 'fastify';
import { cancelAnyJob } from '../domain/jobs.js';
import { operatorQueue } from '../domain/operator.js';
import { setQueuePaused } from '../domain/queue-control.js';
import { moveJob } from '../domain/queue-order.js';
import type { RouteDeps } from './deps.js';
import { resultUrl } from './links.js';
import { answerWhenChanged, waitQuery } from './long-poll.js';
import { parse } from './parse.js';

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

  app.get('/jobs', { config: { quiet: true } }, async (req, reply) =>
    answerWhenChanged(req, reply, closing.signal, view, parse(waitQuery, req.query)),
  );

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
