import { readFile } from 'node:fs/promises';
import { conflict, notFound } from '../domain/errors.js';
import type { FileRow } from '../domain/files.js';
import type { JobRow } from '../domain/jobs.js';
import { downloadableFile } from '../domain/outputs.js';
import { INLINE_IMAGE_BYTES, INLINE_IMAGE_MIMES, INLINE_TEXT_BYTES, isTextMime } from '../files/mime.js';
import type { RouteDeps } from '../http/deps.js';
import { downloadUrl } from '../http/links.js';
import type { Block } from './server.js';

const json = (v: unknown): Block => ({ type: 'text', text: JSON.stringify(v) });
const showable = (f: FileRow | null): f is FileRow => f !== null && INLINE_IMAGE_MIMES.has(f.mime) && f.size <= INLINE_IMAGE_BYTES;

/**
 * get_output: first a JSON block about the file with a signed download link; then its preview (or the file itself)
 * as an image block, or its text when it is short text; otherwise the JSON says to use the link.
 */
export async function outputBlocks(deps: RouteDeps, job: JobRow, name: string): Promise<Block[]> {
  if (!job.manifest) throw conflict(`the job is ${job.state}; its outputs are ready once it has finished`);
  const file = downloadableFile(deps.db, job, name);
  if (!file) throw notFound(`output ${name} not found; get_job lists the outputs`);
  const entry = job.manifest.outputs.find((o) => o.name === file.name);
  const link = downloadUrl(deps, job, file);
  const info = {
    name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, meta: entry?.meta ?? null,
    download_url: link.url, link_expires_at: link.expiresAt.toISOString(),
  };
  const preview = entry?.preview ? downloadableFile(deps.db, job, entry.preview) : null;
  const image = showable(preview) ? preview : showable(file) ? file : null;
  if (image) {
    const data = await readFile(deps.store.pathOf(image.id));
    return [json(image === file ? info : { ...info, preview: image.name }), { type: 'image', data: data.toString('base64'), mimeType: image.mime }];
  }
  if (isTextMime(file.mime) && file.size <= INLINE_TEXT_BYTES) {
    return [json(info), { type: 'text', text: (await readFile(deps.store.pathOf(file.id))).toString('utf8') }];
  }
  const note = isTextMime(file.mime) ? `larger than ${INLINE_TEXT_BYTES / 1000} kB: download it with the link` : 'download it with the link';
  return [json({ ...info, note })];
}
