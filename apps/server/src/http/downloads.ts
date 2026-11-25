import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { notFound } from '../domain/errors.js';
import type { FileRow } from '../domain/files.js';
import { getOwnJob } from '../domain/jobs.js';
import { archiveFiles, downloadableFile } from '../domain/outputs.js';
import { type ZipEntry, zipSize, zipStream } from '../files/zip.js';
import { authorize, bearerOf } from './auth.js';
import type { RouteDeps } from './deps.js';
import { fileOfDownloadLink, jobOfArchiveLink } from './links.js';

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

  // Spec 14 § 4: every output and the log as one ZIP, through a signed link only.
  app.get<{ Params: { id: string }; Querystring: { sig?: unknown } }>('/jobs/:id/archive.zip', async (req, reply) => {
    const job = typeof req.query.sig === 'string' ? jobOfArchiveLink(deps, req.params.id, req.query.sig) : null;
    if (!job) throw notFound('the archive link is unknown or expired');
    if (!job.manifest || job.manifest.outputs.length === 0) throw notFound('the job has no outputs');
    const rows = archiveFiles(deps.db, job);
    for (const row of rows) {
      // Checked before the first byte: a 200 with a ZIP cut short would look complete to a client.
      if (!row || !(await stat(deps.store.pathOf(row.id)).then(() => true, () => false))) throw notFound('an output is no longer on the server');
    }
    const entries: ZipEntry[] = (rows as FileRow[]).map((f) => ({ name: f.name, size: f.size, open: () => deps.store.openRead(f.id) }));
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', zipSize(entries))
      .header('content-disposition', `attachment; filename="${job.type}-${job.id}.zip"`)
      .header('cache-control', 'private, max-age=0')
      .send(zipStream(entries, job.finishedAt ?? deps.clock()));
  });
};

async function sendFile(deps: RouteDeps, reply: FastifyReply, file: FileRow) {
  try {
    await stat(deps.store.pathOf(file.id));
  } catch {
    // The row outlived its disk file (a restore without files, a disk error): nothing to serve.
    throw notFound(`output ${file.name} not found`);
  }
  return reply
    .header('content-type', file.mime)
    .header('content-length', file.size)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, max-age=0')
    .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(basename(file.name))}`)
    .send(deps.store.openRead(file.id));
}
