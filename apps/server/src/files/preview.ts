import sharp from 'sharp';

// libvips keeps recently opened files open in its cache; on Windows an open file cannot be deleted or replaced.
sharp.cache(false);

export const PREVIEW_MAX_PX = 1024;
export const PREVIEW_QUALITY = 80;
/** Larger sources get no server preview: decoding them would hold the upload request too long. */
export const PREVIEW_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const PREVIEW_MAX_PIXELS = 100_000_000;
const PREVIEW_TIMEOUT_S = 30;
export const PREVIEWABLE: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/tiff', 'image/gif']);

/** Where the server keeps an output's preview. Tool outputs cannot start with a dot, so this never collides with one. */
export const serverPreviewName = (output: string): string => `.fornax/previews/${output}.jpg`;

/** A JPEG of at most 1024 px on the longer side (never enlarged), transparency on white. Throws when the file is no image. */
export async function renderPreview(sourcePath: string): Promise<Buffer> {
  return sharp(sourcePath, { limitInputPixels: PREVIEW_MAX_PIXELS })
    .autoOrient()
    .resize({ width: PREVIEW_MAX_PX, height: PREVIEW_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: PREVIEW_QUALITY })
    .timeout({ seconds: PREVIEW_TIMEOUT_S })
    .toBuffer();
}
