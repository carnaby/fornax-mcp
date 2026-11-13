import Fastify, { type FastifyInstance } from 'fastify';

// Grows in later tasks (config, db, store, clock).
export type AppDeps = Record<string, never>;

export async function buildApp(_deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
