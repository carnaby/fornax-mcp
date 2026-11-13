import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { PREVIEW_MAX_SOURCE_BYTES, PREVIEWABLE, renderPreview, serverPreviewName } from '../files/preview.js';
import type { RouteDeps } from '../http/deps.js';
import { deleteFiles, type FileRow, saveFile } from './files.js';
import { jobFile } from './outputs.js';

/**
 * After an output is stored: a JPEG preview of it as `.fornax/previews/<name>.jpg` (kind preview) when it is an image.
 * The preview of an earlier upload under the same name goes first. An image that cannot be decoded gets none; the
 * upload itself still counts.
 */
export async function attachServerPreview(deps: RouteDeps, output: FileRow, log: Pick<FastifyBaseLogger, 'warn'>): Promise<FileRow | null> {
  if (output.kind !== 'output' || output.jobId === null) return null;
  const name = serverPreviewName(output.name);
  const previous = jobFile(deps.db, output.jobId, name);
  if (previous) await deleteFiles(deps, [previous]);
  if (!PREVIEWABLE.has(output.mime) || output.size > PREVIEW_MAX_SOURCE_BYTES) return null;
  let jpeg: Buffer;
  try {
    jpeg = await renderPreview(deps.store.pathOf(output.id));
  } catch {
    // The decoder's message may describe the file's content; the id is enough to find it.
    log.warn({ file: output.id }, 'no preview: the image could not be decoded');
    return null;
  }
  return saveFile(deps, { owner: output.ownerTokenId, name, kind: 'preview', jobId: output.jobId, source: Readable.from([jpeg]), maxBytes: jpeg.length });
}
