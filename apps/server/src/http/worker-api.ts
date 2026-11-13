import { announceBody, claimBody, completeBody, failBody, heartbeatBody, releaseBody, WORKER_HEADERS } from '@fornax/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { files } from '../db/schema.js';
import { notFound } from '../domain/errors.js';
import { announceTypes } from '../domain/job-types.js';
import { claimJob, claimView, failJob, heartbeatJob, ownedJob, releaseJob } from '../domain/queue.js';
import { completeJob, discardOutputs, outputBudget, storeOutput } from '../domain/outputs.js';
import { jobSignal } from '../domain/signal.js';
import { touchWorker } from '../domain/worker-state.js';
import { requireRole } from './auth.js';
import type { RouteDeps } from './deps.js';
import { parse } from './parse.js';
import { rawBody, refuseOversized } from './uploads.js';

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

  // On shutdown waiting claims answer at once instead of holding the close up.
  const closing = new AbortController();
  app.addHook('preClose', async () => closing.abort());

  app.post('/jobs/claim', async (req, reply) => {
    const { wait } = parse(claimBody, req.body ?? {});
    const deadline = Date.now() + wait * 1000;
    const stop = new AbortController();
    let gone = req.raw.socket?.destroyed === true;
    const hangUp = () => {
      gone = true;
      stop.abort();
    };
    const shutDown = () => stop.abort();
    reply.raw.on('close', hangUp);
    closing.signal.addEventListener('abort', shutDown, { once: true });
    if (gone || closing.signal.aborted) stop.abort();
    try {
      for (;;) {
        // Checked before every claim: a job taken for a worker that is gone would cost an attempt.
        if (stop.signal.aborted) return reply.code(204).send();
        const job = claimJob(deps.db, deps.clock());
        if (job) {
          if (!gone) return claimView(deps.db, job);
          releaseJob(deps.db, job.id, job.leaseId!, deps.clock());
          return reply.code(204).send();
        }
        const left = deadline - Date.now();
        if (left <= 0) return reply.code(204).send();
        // Woken at once by a new job; every 5 s anyway, for back-offs and leases that ran out meanwhile.
        await jobSignal.wait(Math.min(left, 5000), stop.signal);
      }
    } finally {
      closing.signal.removeEventListener('abort', shutDown);
      reply.raw.off('close', hangUp);
    }
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/heartbeat', async (req) => {
    const b = parse(heartbeatBody, req.body);
    const r = heartbeatJob(deps.db, req.params.id, b.lease, { progress: b.progress, message: b.message }, deps.clock());
    return { lease_until: r.leaseUntil?.toISOString() ?? null, cancel: r.cancel };
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/fail', async (req) => {
    const b = parse(failBody, req.body);
    const r = failJob(deps.db, req.params.id, b.lease, { error: b.error, permanent: b.permanent }, deps.clock());
    await discardOutputs(deps, req.params.id, { keepLog: r.state === 'failed' });
    return { state: r.state, retry_at: r.retryAt?.toISOString() ?? null };
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/release', async (req, reply) => {
    const b = parse(releaseBody, req.body);
    releaseJob(deps.db, req.params.id, b.lease, deps.clock());
    await discardOutputs(deps, req.params.id, { keepLog: false });
    return reply.code(204).send();
  });

  await app.register(async (raw) => {
    rawBody(raw);
    raw.put<{ Params: { id: string; '*': string }; Querystring: { kind?: string } }>('/jobs/:id/outputs/*', async (req, reply) => {
      const lease = parse(z.string().min(1), req.headers[WORKER_HEADERS.lease]);
      const kind = parse(z.enum(['output', 'log']).default('output'), req.query.kind);
      refuseOversized(req, outputBudget(deps, req.params.id, lease, req.params['*']));
      const row = await storeOutput(deps, { jobId: req.params.id, lease, name: req.params['*'], kind, source: req.raw });
      return reply.code(201).send({ name: row.name, size: row.size, sha256: row.sha256 });
    });
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/complete', async (req) => {
    const b = parse(completeBody, req.body);
    return completeJob(deps.db, req.params.id, b.lease, b, deps.clock());
  });

  app.get<{ Params: { id: string; name: string } }>('/jobs/:id/inputs/:name', async (req, reply) => {
    const lease = parse(z.string().min(1), req.headers[WORKER_HEADERS.lease]);
    const job = ownedJob(deps.db, req.params.id, lease, ['running']);
    const fileId = Object.hasOwn(job.inputs, req.params.name) ? job.inputs[req.params.name] : undefined;
    const file = fileId ? deps.db.select().from(files).where(eq(files.id, fileId)).get() : undefined;
    if (!file) throw notFound(`input ${req.params.name} not found`);
    return reply.header('content-type', 'application/octet-stream').header('content-length', file.size).send(deps.store.openRead(file.id));
  });
};
