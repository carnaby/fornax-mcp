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
