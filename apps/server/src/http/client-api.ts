import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from './auth.js';
import type { RouteDeps } from './deps.js';

/** /api/*: the client API. Only tokens with role "client" open it. */
export const clientRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.addHook('onRequest', requireRole(deps, 'client'));

  app.get('/whoami', async (req) => ({ name: req.identity!.name, role: req.identity!.role }));
};
