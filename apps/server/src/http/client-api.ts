import { priorityBody, priorityInput, requeueBody } from '@fornax/protocol';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createUploadLink, fileView, getOwnFile, saveFile, uploadLinkView } from '../domain/files.js';
import { cancelJob, getOwnJob, GROUP, JOB_STATES, jobDetail, jobView, listJobs, submitJob, submitWarning } from '../domain/jobs.js';
import { offeredTypes, typeView } from '../domain/job-types.js';
import { queueStatus } from '../domain/maintenance.js';
import { requeueJob, setJobPriority } from '../domain/priority.js';
import { workerOnline } from '../domain/worker-state.js';
import { requireRole } from './auth.js';
import type { RouteDeps } from './deps.js';
import { answerWhenChanged, waitQuery } from './long-poll.js';
import { parse } from './parse.js';
import { rawBody, refuseOversized } from './uploads.js';

/** /api/*: the client API. Only tokens with role "client" open it. */
export const clientRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.addHook('onRequest', requireRole(deps, 'client'));
  // On shutdown waiting requests answer at once instead of holding the close up.
  const closing = new AbortController();
  app.addHook('preClose', async () => closing.abort());

  app.get('/whoami', async (req) => ({ name: req.identity!.name, role: req.identity!.role }));

  app.get('/types', async () => ({ types: offeredTypes(deps.db).map(typeView), worker: workerOnline(deps.db, deps.clock()) }));

  app.get('/queue', async (req) => {
    const { job_id } = parse(z.object({ job_id: z.string().min(1).max(40).optional() }), req.query);
    return queueStatus(deps.db, deps.clock(), req.identity!.tokenId, job_id);
  });

  // Raw uploads live in a child plugin so JSON parsing stays on for the other routes.
  await app.register(async (raw) => {
    rawBody(raw);
    raw.post('/files', async (req, reply) => {
      const { name } = parse(z.object({ name: z.string().min(1).max(500) }), req.query);
      refuseOversized(req, deps.config.limits.maxUploadBytes);
      const row = await saveFile(deps, { owner: req.identity!.tokenId, name, kind: 'input', source: req.raw, maxBytes: deps.config.limits.maxUploadBytes });
      return reply.code(201).send(fileView(row));
    });
  });

  app.get<{ Params: { id: string } }>('/files/:id', async (req) => fileView(getOwnFile(deps.db, req.identity!.tokenId, req.params.id)));

  app.post('/uploads', async (req, reply) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(500) }), req.body);
    return reply.code(201).send(uploadLinkView(createUploadLink(deps, req.identity!.tokenId, name)));
  });

  const submitSchema = z.strictObject({
    type: z.string().min(1).max(40),
    params: z.record(z.string(), z.unknown()).default({}),
    inputs: z.record(z.string(), z.string().min(1).max(40)).default({}),
    priority: priorityInput.optional(),
    group: z.string().regex(GROUP).nullable().default(null),
    agent: z.string().max(200).nullable().default(null),
    callback_url: z.string().max(2000).nullable().default(null),
  });

  app.post('/jobs', async (req, reply) => {
    const body = parse(submitSchema, req.body);
    const row = submitJob(deps.db, deps.config, req.identity!.tokenId, body, deps.clock());
    const warning = submitWarning(row);
    return reply.code(201).send({ ...jobDetail(deps.db, deps.config, row, deps.clock()), ...(warning ? { warning } : {}) });
  });

  app.get('/jobs', async (req) => {
    const q = parse(
      z.object({
        state: z.enum(JOB_STATES).optional(),
        group: z.string().regex(GROUP).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return { jobs: listJobs(deps.db, req.identity!.tokenId, q).map((r) => jobView(deps.db, r)) };
  });

  // Spec 05a 5.1: with `wait`, answer when the job's change differs from `change`, at the latest after `wait` seconds.
  app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const q = parse(waitQuery, req.query);
    const owner = req.identity!.tokenId;
    const read = () => jobDetail(deps.db, deps.config, getOwnJob(deps.db, owner, req.params.id), deps.clock());
    return answerWhenChanged(req, reply, closing.signal, read, q);
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (req) =>
    jobView(deps.db, cancelJob(deps.db, req.identity!.tokenId, req.params.id, deps.clock())),
  );

  // Spec 07 § 4.1: the caller's own jobs only (another owner's job answers 404, like cancel).
  app.post<{ Params: { id: string } }>('/jobs/:id/priority', async (req) => {
    const { priority } = parse(priorityBody, req.body);
    return jobDetail(deps.db, deps.config, setJobPriority(deps.db, req.params.id, priority, deps.clock(), req.identity!.tokenId), deps.clock());
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/requeue', async (req) => {
    const { idle } = parse(requeueBody, req.body ?? {});
    return jobDetail(deps.db, deps.config, requeueJob(deps.db, req.params.id, { idle }, deps.clock(), req.identity!.tokenId), deps.clock());
  });
};
