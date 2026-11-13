import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { DomainError } from '../domain/errors.js';
import { FileStore } from '../files/store.js';
import { clientRoutes } from './client-api.js';
import { downloadRoutes } from './downloads.js';
import type { RouteDeps } from './deps.js';
import { uploadLinkRoutes } from './uploads.js';
import { workerRoutes } from './worker-api.js';

export type AppDeps = {
  config: Config;
  db: Db;
  store?: FileStore;
  clock?: () => Date;
  /** Tests only: where logs go (default stdout). */
  logStream?: { write(msg: string): void };
};

/** Tokens and signatures in URLs never reach the logs. */
export function maskUrl(url: string): string {
  return url
    .replace(/^\/+mcp\/[^?#]+/, '/mcp/***')
    .replace(/^\/+api\/uploads\/[^?#]+/, '/api/uploads/***')
    .replace(/^\/+r\/[^?#]+/, '/r/***')
    .replace(/([?&]sig=)[^&#]*/gi, '$1***');
}

/** Query strings carry client file names and groups; the logs get the path only. */
const withoutQuery = (url: string): string => url.replace(/[?#].*$/s, '');

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const routeDeps: RouteDeps = {
    config: deps.config,
    db: deps.db,
    store: deps.store ?? new FileStore(deps.config.filesDir),
    clock: deps.clock ?? (() => new Date()),
  };
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // Unmatched URLs are not logged at all: any path may carry a secret.
      serializers: { req: (req) => ({ method: req.method, url: req.is404 ? '(unmatched)' : maskUrl(withoutQuery(req.url)) }) },
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

  app.get('/healthz', async () => {
    routeDeps.db.get(sql`select 1`);
    return { ok: true };
  });
  // Siblings: each plugin's auth hook applies only to its own routes.
  await app.register(workerRoutes, { prefix: '/api/worker', ...routeDeps });
  await app.register(uploadLinkRoutes, routeDeps);
  await app.register(downloadRoutes, { prefix: '/api', ...routeDeps });
  await app.register(clientRoutes, { prefix: '/api', ...routeDeps });
  return app;
}
