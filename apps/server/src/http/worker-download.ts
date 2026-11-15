import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { FORNAX_VERSION, type WorkerBundleInfo } from '@fornax/protocol';
import type { FastifyPluginAsync } from 'fastify';
import { notFound } from '../domain/errors.js';
import type { RouteDeps } from './deps.js';

/** The bundle's size, or null when there is none. */
async function bundleStat(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** GET /downloads/fornax-worker.{zip,json}: the worker bundle shipped with the server (spec 3) and its checksum (spec 05c 6). Public: the code is open source. */
export const workerDownloadRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  // Hashed once per version of the file: the first request after start, and again when the zip is replaced.
  let cached: { key: string; info: WorkerBundleInfo } | null = null;

  app.get('/downloads/fornax-worker.zip', async (_req, reply) => {
    const s = await bundleStat(deps.config.workerZip);
    if (!s) throw notFound('this server has no worker bundle');
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', s.size)
      .header('content-disposition', `attachment; filename="fornax-worker-${FORNAX_VERSION}.zip"`)
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(deps.config.workerZip));
  });

  app.get('/downloads/fornax-worker.json', async (_req, reply) => {
    const s = await bundleStat(deps.config.workerZip);
    if (!s) throw notFound('this server has no worker bundle');
    const key = `${s.size}:${s.mtimeMs}`;
    if (cached?.key !== key) {
      const bytes = await readFile(deps.config.workerZip);
      cached = { key, info: { version: FORNAX_VERSION, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } };
    }
    return reply.header('cache-control', 'no-cache').send(cached.info);
  });
};
