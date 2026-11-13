import sharp from 'sharp';

// libvips keeps recently opened files open in its cache; on Windows an open file cannot be deleted or replaced.
sharp.cache(false);

export const PREVIEW_MAX_PX = 1024;
export const PREVIEW_QUALITY = 80;
/** Larger sources get no server preview: decoding them would hold the upload request too long. */
export const PREVIEW_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const PREVIEW_MAX_PIXELS = 100_000_000;
const PREVIEW_TIMEOUT_S = 30;
export const PREVIEWABLE: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/tiff', 'image/gif']);
/** The decoders a preview may use, by the format sharp finds in the bytes (never SVG, PDF or others, whatever the name). */
const DECODABLE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp', 'tiff', 'gif']);

/** Where the server keeps an output's preview. Tool outputs cannot start with a dot, so this never collides with one. */
export const serverPreviewName = (output: string): string => `.fornax/previews/${output}.jpg`;

/** Format and size the bytes of an image have; throws when they are no image. */
export async function imageInfo(source: string | Buffer): Promise<{ format: string; width: number; height: number }> {
  const m = await sharp(source, { limitInputPixels: false }).metadata();
  return { format: m.format ?? '', width: m.width ?? 0, height: m.height ?? 0 };
}

/**
 * A JPEG of at most 1024 px on the longer side (never enlarged), transparency on white. Throws when the file is no
 * image in an allowed format, or larger than 100 megapixels.
 */
export async function renderPreview(source: string | Buffer): Promise<Buffer> {
  const info = await imageInfo(source);
  if (!DECODABLE_FORMATS.has(info.format)) throw new Error('not an image format previews are made of');
  if (info.width * info.height > PREVIEW_MAX_PIXELS) throw new Error('too many pixels for a preview');
  return sharp(source, { limitInputPixels: PREVIEW_MAX_PIXELS })
    .autoOrient()
    .resize({ width: PREVIEW_MAX_PX, height: PREVIEW_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: PREVIEW_QUALITY })
    .timeout({ seconds: PREVIEW_TIMEOUT_S })
    .toBuffer();
}
