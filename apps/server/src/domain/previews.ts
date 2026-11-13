import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { files } from '../db/schema.js';
import { PREVIEW_MAX_SOURCE_BYTES, PREVIEWABLE, renderPreview, serverPreviewName } from '../files/preview.js';
import type { RouteDeps } from '../http/deps.js';
import { deleteFiles, type FileRow, saveFile } from './files.js';
import { jobFile } from './outputs.js';

/**
 * After an output is stored: a JPEG preview of it as `.fornax/previews/<name>.jpg` (kind preview) when it is an image.
 * The preview of an earlier upload under the same name goes first. A preview is optional: an image that cannot be
 * decoded, or a disk error while storing the preview, leaves the output without one and the upload still counts.
 * Failures are logged with file ids only (a decoder's or the file system's message may describe the content or paths).
 */
export async function attachServerPreview(deps: RouteDeps, output: FileRow, log: Pick<FastifyBaseLogger, 'warn'>): Promise<FileRow | null> {
  try {
    return await makePreview(deps, output, log);
  } catch {
    log.warn({ file: output.id }, 'no preview: it could not be made');
    return null;
  }
}

async function makePreview(deps: RouteDeps, output: FileRow, log: Pick<FastifyBaseLogger, 'warn'>): Promise<FileRow | null> {
  if (output.kind !== 'output' || output.jobId === null) return null;
  const name = serverPreviewName(output.name);
  const previous = jobFile(deps.db, output.jobId, name);
  if (previous) {
    try {
      await deleteFiles(deps, [previous]);
    } catch {
      // The old preview shows the previous upload: its row goes in any case; its file stays behind on disk.
      log.warn({ file: output.id, preview: previous.id }, 'the previous preview could not be removed');
      deps.db.delete(files).where(eq(files.id, previous.id)).run();
    }
  }
  if (!PREVIEWABLE.has(output.mime) || output.size > PREVIEW_MAX_SOURCE_BYTES) return null;
  let jpeg: Buffer;
  try {
    jpeg = await renderPreview(deps.store.pathOf(output.id));
  } catch {
    log.warn({ file: output.id }, 'no preview: the image could not be decoded');
    return null;
  }
  try {
    return await saveFile(deps, { owner: output.ownerTokenId, name, kind: 'preview', jobId: output.jobId, source: Readable.from([jpeg]), maxBytes: jpeg.length });
  } catch {
    log.warn({ file: output.id }, 'no preview: it could not be stored');
    return null;
  }
}
