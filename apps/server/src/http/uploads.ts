import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { notFound } from '../domain/errors.js';
import { fileView, releaseUploadLink, saveFile, takeUploadLink } from '../domain/files.js';
import type { RouteDeps } from './deps.js';
import { verify } from './signing.js';

/** Leave request bodies unread in this plugin: handlers stream req.raw themselves. */
export function rawBody(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));
}

/** PUT /api/uploads/<signed>: one upload through a link, no token (the signature is the permission). */
export const uploadLinkRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  rawBody(app);
  app.put<{ Params: { signed: string } }>('/api/uploads/:signed', async (req, reply) => {
    const now = deps.clock();
    const id = verify(deps.config.secret, req.params.signed, now);
    const link = id ? takeUploadLink(deps.db, id, now) : null;
    if (!link) throw notFound('the upload link is unknown, used or expired');
    try {
      const row = await saveFile(deps, {
        owner: link.ownerTokenId, id: link.fileId, name: link.name, kind: 'input', source: req.raw, maxBytes: deps.config.limits.maxUploadBytes,
      });
      return reply.code(201).send(fileView(row));
    } catch (e) {
      releaseUploadLink(deps.db, link.id);
      throw e;
    }
  });
};
