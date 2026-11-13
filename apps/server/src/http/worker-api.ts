import { announceBody, WORKER_HEADERS } from '@fornax/protocol';
import type { FastifyPluginAsync } from 'fastify';
import { announceTypes } from '../domain/job-types.js';
import { touchWorker } from '../domain/worker-state.js';
import { requireRole } from './auth.js';
import type { RouteDeps } from './deps.js';
import { parse } from './parse.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The call is no sign of life (a status question, not the running worker). */
    quiet?: boolean;
  }
}

const HOSTNAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const hostnameOf = (raw: unknown) => {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return HOSTNAME.test(v) ? v : 'worker';
};
const versionOf = (raw: unknown) => (typeof raw === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(raw) ? raw : null);

/** /api/worker/*: the worker API. Only the worker token opens it. */
export const workerRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.addHook('onRequest', requireRole(deps, 'worker'));
  app.addHook('preHandler', async (req) => {
    if (req.routeOptions.config.quiet) return;
    touchWorker(
      deps.db,
      { tokenId: req.identity!.tokenId, hostname: hostnameOf(req.headers[WORKER_HEADERS.name]), version: versionOf(req.headers[WORKER_HEADERS.version]) },
      deps.clock(),
    );
  });

  app.get('/ping', async () => ({ ok: true }));

  app.put('/types', async (req) => {
    const { types } = parse(announceBody, req.body);
    return announceTypes(deps.db, types, deps.clock());
  });
};
