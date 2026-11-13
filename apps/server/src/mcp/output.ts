import { readFile } from 'node:fs/promises';
import { conflict, notFound } from '../domain/errors.js';
import type { FileRow } from '../domain/files.js';
import type { JobRow } from '../domain/jobs.js';
import { downloadableFile } from '../domain/outputs.js';
import { INLINE_IMAGE_BYTES, INLINE_IMAGE_MIMES, INLINE_TEXT_BYTES, isTextMime } from '../files/mime.js';
import type { RouteDeps } from '../http/deps.js';
import { downloadUrl } from '../http/links.js';
import type { Block } from './types.js';

const json = (v: unknown): Block => ({ type: 'text', text: JSON.stringify(v) });
const showable = (f: FileRow | null): f is FileRow => f !== null && INLINE_IMAGE_MIMES.has(f.mime) && f.size <= INLINE_IMAGE_BYTES;

/** The image type the bytes themselves have (never the extension's claim), or null when it is no inline image format. */
function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

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
  for (const candidate of [preview, file]) {
    if (!showable(candidate)) continue;
    const data = await readFile(deps.store.pathOf(candidate.id));
    const mimeType = sniffImage(data);
    if (mimeType) return [json(candidate === file ? info : { ...info, preview: candidate.name }), { type: 'image', data: data.toString('base64'), mimeType }];
  }
  if (isTextMime(file.mime) && file.size <= INLINE_TEXT_BYTES) {
    const data = await readFile(deps.store.pathOf(file.id));
    if (!data.includes(0)) return [json(info), { type: 'text', text: data.toString('utf8') }];
    return [json({ ...info, note: 'not readable text: download it with the link' })];
  }
  const note = isTextMime(file.mime) ? `larger than ${INLINE_TEXT_BYTES / 1000} kB: download it with the link` : 'download it with the link';
  return [json({ ...info, note })];
}
