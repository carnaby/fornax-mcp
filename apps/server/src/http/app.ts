import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { DomainError } from '../domain/errors.js';
import { FileStore } from '../files/store.js';
import { mcpRoutes } from '../mcp/routes.js';
import { clientRoutes } from './client-api.js';
import { downloadRoutes } from './downloads.js';
import type { RouteDeps } from './deps.js';
import { pairPageRoutes } from './pages/pair.js';
import { workerDownloadRoutes } from './worker-download.js';
import { resultPageRoutes } from './pages/result.js';
import { uploadLinkRoutes } from './uploads.js';
import { workerRoutes } from './worker-api.js';

export type AppDeps = {
  config: Config;
  db: Db;
  store?: FileStore;
  clock?: () => Date;
  /** Tests only: where logs go (default stdout). */
  logStream?: { write(msg: string): void };
  /** When the maintenance loop last finished a pass (main.ts); /healthz is 503 once that is too long ago. */
  maintenanceAt?: () => Date;
};

/** /healthz turns 503 when the maintenance loop (every minute) has not finished a pass for this long. */
export const MAINTENANCE_STALE_MS = 600_000;

/** Tokens and signatures in URLs never reach the logs. */
export function maskUrl(url: string): string {
  return url
    .replace(/^\/+mcp\/[^?#]+/, '/mcp/***')
    .replace(/^\/+api\/uploads\/[^?#]+/, '/api/uploads/***')
    .replace(/^\/+r\/[^?#]+/, '/r/***')
    .replace(/^\/+pair\/[^?#]+/, '/pair/***')
    .replace(/([?&]sig=)[^&#]*/gi, '$1***');
}

/** Query strings carry client file names and groups; the logs get the path only. */
const withoutQuery = (url: string): string => url.replace(/[?#].*$/s, '');

/**
 * The URL a log line gets. A route that carries a secret is logged as its masked template: the router decodes
 * percent-encoded paths, so "/%70air/<id>" reaches /pair/:invite while its raw URL slips past maskUrl. Other routes
 * keep their path (ids help) without the query; unmatched URLs are not logged at all, since any path may carry a secret.
 */
export function logUrl(req: { url: string; is404: boolean; routeOptions: { url?: string | undefined } }): string {
  if (req.is404) return '(unmatched)';
  const route = req.routeOptions.url;
  if (route !== undefined && maskUrl(route) !== route) return maskUrl(route);
  return maskUrl(withoutQuery(req.url));
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const routeDeps: RouteDeps = {
    config: deps.config,
    db: deps.db,
    store: deps.store ?? new FileStore(deps.config.filesDir),
    clock: deps.clock ?? (() => new Date()),
  };
  const app = Fastify({
    // Exactly as many proxies as configured may set the client address and scheme (X-Forwarded-For/-Proto).
    // Fastify 5 treats a plain number as "trust nobody", so the hop count is spelled out as a function.
    trustProxy: deps.config.trustProxy > 0 ? (_address: string, hop: number) => hop < deps.config.trustProxy : false,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      serializers: { req: (req: FastifyRequest) => ({ method: req.method, url: logUrl(req) }) },
    },
  });

  // The default 404 handler logs and echoes the raw URL, which may hold a token.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'not found' }));

  app.setErrorHandler<FastifyError>((err, req, reply) => {
    if (err instanceof DomainError) {
      // After an oversized upload the rest of the body is never read: close the connection.
      if (err.status === 413) reply.header('connection', 'close');
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      // Message and stack only: database errors may carry query values (params, names).
      req.log.error({ err: { message: err.message, stack: err.stack } }, 'request failed');
      return reply.code(status).send({ error: 'internal', message: 'internal error' });
    }
    return reply.code(status).send({ error: 'bad_request', message: err.message });
  });

  app.get('/healthz', async (_req, reply) => {
    routeDeps.db.get(sql`select 1`);
    const at = deps.maintenanceAt?.();
    if (at && routeDeps.clock().getTime() - at.getTime() > MAINTENANCE_STALE_MS) {
      return reply.code(503).send({ ok: false, error: 'maintenance_stalled' });
    }
    return { ok: true };
  });
  // Siblings: each plugin's auth hook applies only to its own routes.
  await app.register(workerRoutes, { prefix: '/api/worker', ...routeDeps });
  await app.register(uploadLinkRoutes, routeDeps);
  await app.register(downloadRoutes, { prefix: '/api', ...routeDeps });
  await app.register(clientRoutes, { prefix: '/api', ...routeDeps });
  await app.register(mcpRoutes, routeDeps);
  await app.register(resultPageRoutes, routeDeps);
  await app.register(pairPageRoutes, routeDeps);
  await app.register(workerDownloadRoutes, routeDeps);
  return app;
}
