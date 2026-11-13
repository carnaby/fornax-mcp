import { basename } from 'node:path';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { notFound } from '../domain/errors.js';
import type { FileRow } from '../domain/files.js';
import { getOwnJob } from '../domain/jobs.js';
import { downloadableFile } from '../domain/outputs.js';
import { authorize, bearerOf } from './auth.js';
import type { RouteDeps } from './deps.js';
import { fileOfDownloadLink } from './links.js';

/**
 * GET /api/jobs/:id/outputs/*: with a client token (the owner's job only), or without a token through a signed
 * `?sig=` link. A request that carries a token always takes the token path.
 */
export const downloadRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.get<{ Params: { id: string; '*': string }; Querystring: { sig?: unknown } }>('/jobs/:id/outputs/*', async (req, reply) => {
    const name = req.params['*'];
    const raw = bearerOf(req);
    let file: FileRow | null;
    if (raw === null && typeof req.query.sig === 'string') {
      file = fileOfDownloadLink(deps, req.params.id, name, req.query.sig);
    } else {
      const identity = authorize(deps, raw, 'client', reply);
      if (!identity) return reply;
      file = downloadableFile(deps.db, getOwnJob(deps.db, identity.tokenId, req.params.id), name);
    }
    if (!file) throw notFound(`output ${name} not found`);
    return sendFile(deps, reply, file);
  });
};

function sendFile(deps: RouteDeps, reply: FastifyReply, file: FileRow) {
  return reply
    .header('content-type', file.mime)
    .header('content-length', file.size)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, max-age=0')
    .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(basename(file.name))}`)
    .send(deps.store.openRead(file.id));
}
