import { readFile, stat } from 'node:fs/promises';
import { conflict, notFound } from '../domain/errors.js';
import type { FileRow } from '../domain/files.js';
import type { JobRow } from '../domain/jobs.js';
import { downloadableFile, jobFile } from '../domain/outputs.js';
import { INLINE_IMAGE_BYTES, INLINE_TEXT_BYTES, isTextMime } from '../files/mime.js';
import { imageInfo, PREVIEW_MAX_SOURCE_BYTES, PREVIEWABLE, renderPreview, serverPreviewName } from '../files/preview.js';
import { textWindow } from '../files/text-window.js';
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
export async function outputBlocks(deps: RouteDeps, job: JobRow, name: string, window: { offset?: number; maxBytes?: number } = {}): Promise<Block[]> {
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
  if (file.kind === 'log' || isTextMime(file.mime)) {
    // Spec 14 § 6.1: text in parts. Without an offset a long log starts with its end (how the job went), other text
    // with its beginning.
    const max = window.maxBytes ?? INLINE_TEXT_BYTES;
    const fromEnd = window.offset === undefined && file.kind === 'log' && file.size > max;
    const start = window.offset !== undefined ? Math.min(window.offset, file.size) : fromEnd ? file.size - max : 0;
    const buf = await readOrGone(file, () => deps.store.readRange(file.id, start, Math.min(max, file.size - start)));
    const w = textWindow(buf, start, file.size);
    if (w.binary) return [json({ ...info, note: 'not readable text: download it with the link' })];
    const whole = w.offset === 0 && w.nextOffset === null;
    const note = whole
      ? undefined
      : fromEnd
        ? `the last ${max / 1000} kB of the log; read it from the start with offset 0`
        : `bytes ${w.offset} to ${w.nextOffset ?? file.size} of ${file.size}; pass next_offset as offset for the next part`;
    return [json({ ...info, offset: w.offset, next_offset: w.nextOffset, ...(note ? { note } : {}) }), { type: 'text', text: w.text }];
  }
  return [json({ ...info, note: 'download it with the link' })];
}
