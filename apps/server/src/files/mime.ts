import { extname } from 'node:path';

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.exr': 'image/x-exr',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
  '.json': 'application/json', '.txt': 'text/plain', '.log': 'text/plain', '.srt': 'application/x-subrip', '.vtt': 'text/vtt',
  '.blend': 'application/x-blender',
};

export const mimeOf = (name: string): string => TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** Text a person or an agent can read inline: plain text, JSON, subtitles. */
export const isTextMime = (mime: string): boolean => mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-subrip';

/** Text and JSON up to this size are shown inline (MCP get_output, the result page); get_output gives a longer log's end. */
export const INLINE_TEXT_BYTES = 60_000;

/** Image formats browsers and MCP clients show directly. */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** A larger image is offered as a link only (MCP clients limit the size of an image block). */
export const INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
