import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from './auth.js';
import type { RouteDeps } from './deps.js';

/** /api/worker/*: the worker API. Only the worker token opens it. */
export const workerRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.addHook('onRequest', requireRole(deps, 'worker'));

  app.get('/ping', async () => ({ ok: true }));
};
