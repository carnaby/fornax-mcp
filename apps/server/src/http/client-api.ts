import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createUploadLink, fileView, getOwnFile, saveFile } from '../domain/files.js';
import { offeredTypes, typeView } from '../domain/job-types.js';
import { workerOnline } from '../domain/worker-state.js';
import { requireRole } from './auth.js';
import type { RouteDeps } from './deps.js';
import { parse } from './parse.js';
import { rawBody, refuseOversized } from './uploads.js';

/** /api/*: the client API. Only tokens with role "client" open it. */
export const clientRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.addHook('onRequest', requireRole(deps, 'client'));

  app.get('/whoami', async (req) => ({ name: req.identity!.name, role: req.identity!.role }));

  app.get('/types', async () => ({ types: offeredTypes(deps.db).map(typeView), worker: workerOnline(deps.db, deps.clock()) }));

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
    const link = createUploadLink(deps, req.identity!.tokenId, name);
    return reply.code(201).send({
      file_id: link.fileId,
      url: link.url,
      expires_at: link.expiresAt.toISOString(),
      curl: `curl -fsS -X PUT -H "Content-Type: application/octet-stream" --data-binary @<path> "${link.url}"`,
    });
  });
};
