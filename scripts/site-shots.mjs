// Screenshots for the landing page (spec 2026-11-19, Obrázky): the tray from its preview fixtures (invented data only)
// and the link-preview image. Needs the tray preview: pnpm --filter @fornax/tray preview (http://127.0.0.1:1422).
// Run from the repository root: node scripts/site-shots.mjs. FORNAX_BROWSER names a Chromium-based browser (default:
// Edge on Windows, chromium elsewhere). The result page's image comes from apps/server/test/site-shot.test.ts.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharp = createRequire(join(root, 'apps', 'server', 'package.json'))('sharp');
export const IMG = join(root, 'site', 'img');
const MAX_BYTES = 300_000;
const PREVIEW = 'http://127.0.0.1:1422';
const browser =
  process.env.FORNAX_BROWSER ??
  (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : 'chromium');

/**
 * One headless shot into `png`; a headless browser now and then hangs at exit, so it gets a second try. Asynchronous:
 * the result page's server answers the browser from the same process.
 */
async function capture(url, width, height, png, profile) {
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, '--force-device-scale-factor=2',
    `--window-size=${width},${height + 200}`, '--virtual-time-budget=3000', `--screenshot=${png}`, url,
  ];
  for (let attempt = 1; ; attempt++) {
    try {
      await promisify(execFile)(browser, args, { timeout: 60_000 });
      return;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
}

/**
 * A shot of `url` at twice the pixels, cropped to `width` x `height` CSS pixels from the top-left corner: the window is
 * as wide as the shot (a centred page stays whole) and higher, since a headless window's viewport may be lower. `webp` keeps the double
 * pixels; `png` is scaled to the CSS size and reduced to a palette. Fails when the file is larger than 300 KB.
 */
export async function shot(url, width, height, out, format = 'webp') {
  const tmp = mkdtempSync(join(tmpdir(), 'fornax-shot-'));
  try {
    const png = join(tmp, 'shot.png');
    await capture(url, width, height, png, join(tmp, 'profile'));
    const crop = sharp(png).extract({ left: 0, top: 0, width: width * 2, height: height * 2 });
    mkdirSync(dirname(out), { recursive: true });
    if (format === 'png') await crop.resize(width, height).png({ palette: true, quality: 90, compressionLevel: 9 }).toFile(out);
    else await crop.webp({ quality: 80 }).toFile(out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const bytes = statSync(out).size;
  if (bytes > MAX_BYTES) throw new Error(`${out}: ${bytes} bytes, more than ${MAX_BYTES}`);
  console.log(`${out}: ${bytes} bytes`);
}

/** The tray images: [file, fixture, window height]. */
const TRAY = [
  ['tray-main', 'main', 820], // the hero: a running upscale, three waiting jobs, the history
  ['tray-idle', 'idle', 1000], // A fair queue: priorities and the Idle block (higher, so no list is cut)
  ['tray-lease', 'lease', 820], // Lease the card
  ['tray-days', 'days', 1000], // The tray: today and yesterday in History (higher, so yesterday shows)
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, fixture, height] of TRAY) {
    await shot(`${PREVIEW}/preview/frame.html?fixture=${fixture}&h=${height}`, 400, height, join(IMG, `${name}.webp`));
  }
  await shot(`${PREVIEW}/preview/og.html`, 1200, 630, join(IMG, 'og.png'), 'png');
}
