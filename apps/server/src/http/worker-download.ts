import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { FORNAX_VERSION } from '@fornax/protocol';
import type { FastifyPluginAsync } from 'fastify';
import { notFound } from '../domain/errors.js';
import type { RouteDeps } from './deps.js';

/** GET /downloads/fornax-worker.zip: the worker bundle shipped with the server (spec 3). Public: the code is open source. */
export const workerDownloadRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.get('/downloads/fornax-worker.zip', async (_req, reply) => {
    let size: number;
    try {
      const s = await stat(deps.config.workerZip);
      if (!s.isFile()) throw new Error('not a file');
      size = s.size;
    } catch {
      throw notFound('this server has no worker bundle');
    }
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', size)
      .header('content-disposition', `attachment; filename="fornax-worker-${FORNAX_VERSION}.zip"`)
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(deps.config.workerZip));
  });
};
