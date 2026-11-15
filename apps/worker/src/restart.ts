import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Paths } from './paths.js';

/** Spec 05c 5.2: fornax update asks the running worker to restart on this version. */
export function writeRestartRequest(paths: Paths, version: string): void {
  mkdirSync(dirname(paths.restartFile), { recursive: true });
  const tmp = `${paths.restartFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version, at: new Date().toISOString() })}\n`);
  renameSync(tmp, paths.restartFile);
}

/** The requested version; undefined without a request, null for a file that is no request (damaged, written by hand). */
export function readRestartRequest(paths: Paths): string | null | undefined {
  let text: string;
  try {
    text = readFileSync(paths.restartFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return null;
  }
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
