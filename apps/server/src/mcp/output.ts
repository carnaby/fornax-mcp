import { readFile, stat } from 'node:fs/promises';
import { conflict, notFound } from '../domain/errors.js';
import type { FileRow } from '../domain/files.js';
import type { JobRow } from '../domain/jobs.js';
import { downloadableFile, jobFile } from '../domain/outputs.js';
import { INLINE_IMAGE_BYTES, INLINE_TEXT_BYTES, isTextMime } from '../files/mime.js';
import { imageInfo, PREVIEW_MAX_SOURCE_BYTES, PREVIEWABLE, renderPreview, serverPreviewName } from '../files/preview.js';
import type { RouteDeps } from '../http/deps.js';
import { downloadUrl } from '../http/links.js';
import type { Block } from './types.js';

const json = (v: unknown): Block => ({ type: 'text', text: JSON.stringify(v) });

/** Image blocks larger than this on a side are refused by Claude (8000 px, 2000 px once a conversation holds many images). */
export const IMAGE_BLOCK_MAX_PX = 2000;
/** The formats an image block may carry, by what the bytes are (never by the extension). */
const BLOCK_FORMATS: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

const readOrNull = (deps: RouteDeps, f: FileRow): Promise<Buffer | null> => readFile(deps.store.pathOf(f.id)).catch(() => null);

/** The row outlived its disk file (a restore without files, a disk error): there is nothing to show or download. */
const gone = (f: FileRow) => notFound(`the file of output ${f.name} is no longer on the server`);

/** `read()`, with a missing disk file turned into the tool error of `gone`. */
async function readOrGone<T>(f: FileRow, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw gone(f);
    throw e;
  }
}

/**
 * An image block of `f`: the server's preview of it when there is one (a JPEG of at most 1024 px); else the file itself
 * when it is a browser image of at most 2000 px per side and 2 MiB; else a JPEG of it rendered now. Null when it is no
 * image the server can decode (unknown format, over 100 megapixels, unreadable).
 */
async function imageBlock(deps: RouteDeps, job: JobRow, f: FileRow): Promise<Block | null> {
  const own = f.name.startsWith('.fornax/') ? null : jobFile(deps.db, job.id, serverPreviewName(f.name));
  if (own && own.size <= INLINE_IMAGE_BYTES) {
    const data = await readOrNull(deps, own);
    if (data) return { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' };
  }
  if (!PREVIEWABLE.has(f.mime) || f.size > PREVIEW_MAX_SOURCE_BYTES) return null;
  const path = deps.store.pathOf(f.id);
  try {
    const info = await imageInfo(path);
    const mimeType = BLOCK_FORMATS[info.format];
    if (mimeType && f.size <= INLINE_IMAGE_BYTES && info.width > 0 && info.height > 0 && info.width <= IMAGE_BLOCK_MAX_PX && info.height <= IMAGE_BLOCK_MAX_PX) {
      const data = await readFile(path);
      return { type: 'image', data: data.toString('base64'), mimeType };
    }
    const jpeg = await renderPreview(path);
    return jpeg.length <= INLINE_IMAGE_BYTES ? { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' } : null;
  } catch {
    return null;
  }
}

/**
 * get_output: first a JSON block about the file with a signed download link; then an image block of its preview (or of
 * the file itself), at most 2000 px per side, or its text when it is short text; otherwise the JSON says to use the link.
 */
export async function outputBlocks(deps: RouteDeps, job: JobRow, name: string): Promise<Block[]> {
  if (!job.manifest) throw conflict(`the job is ${job.state}; its outputs are ready once it has finished`);
  const file = downloadableFile(deps.db, job, name);
  if (!file) throw notFound(`output ${name} not found; get_job lists the outputs`);
  // Checked first: the download link of a missing file would only answer 404.
  await readOrGone(file, () => stat(deps.store.pathOf(file.id)));
  const entry = job.manifest.outputs.find((o) => o.name === file.name);
  const link = downloadUrl(deps, job, file);
  const info = {
    name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, meta: entry?.meta ?? null,
    download_url: link.url, link_expires_at: link.expiresAt.toISOString(),
  };
  const preview = entry?.preview ? downloadableFile(deps.db, job, entry.preview) : null;
  for (const candidate of [preview, file]) {
    if (!candidate) continue;
    const image = await imageBlock(deps, job, candidate);
    if (image) return [json(candidate === file ? info : { ...info, preview: candidate.name }), image];
  }
  if (file.kind === 'log' && file.size > INLINE_TEXT_BYTES) {
    // Like the result page: the end of a long log is what tells how the job went.
    const tail = await readOrGone(file, () => deps.store.tail(file.id, INLINE_TEXT_BYTES));
    if (!tail.text.includes('\u0000')) return [json({ ...info, note: `the last ${INLINE_TEXT_BYTES / 1000} kB of the log; download all of it with the link` }), { type: 'text', text: tail.text }];
    return [json({ ...info, note: 'not readable text: download it with the link' })];
  }
  if (isTextMime(file.mime) && file.size <= INLINE_TEXT_BYTES) {
    const data = await readOrGone(file, () => readFile(deps.store.pathOf(file.id)));
    if (!data.includes(0)) return [json(info), { type: 'text', text: data.toString('utf8') }];
    return [json({ ...info, note: 'not readable text: download it with the link' })];
  }
  const note = isTextMime(file.mime) ? `larger than ${INLINE_TEXT_BYTES / 1000} kB: download it with the link` : 'download it with the link';
  return [json({ ...info, note })];
}
