import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION_TEXT } from './install/app.js';
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
    return typeof v === 'string' && VERSION_TEXT.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The worker child's exit code for "start me again" (spec 05c 5.1); the supervisor runs it again. */
export const RESTART_EXIT = 75;

const remove = (file: string) => rmSync(file, { force: true });

/**
 * Spec 05c 5.2: asked between jobs. True means restart now (the request is removed and the line printed). A request
 * for the version this worker is, or a damaged file, is removed; a copy outside app says once what to do and keeps it.
 */
export function restartCheck(paths: Paths, o: { version: string; installed: boolean; out: (line: string) => void }): () => boolean {
  let told = false;
  return () => {
    const v = readRestartRequest(paths);
    if (v === undefined) return false;
    if (v === null || v === o.version) {
      remove(paths.restartFile);
      return false;
    }
    if (!o.installed) {
      if (!told) o.out(`fornax ${v} is installed in ${paths.appDir}; this worker runs from another folder: stop it and run fornax worker`);
      told = true;
      return false;
    }
    remove(paths.restartFile);
    o.out(`restarting for fornax ${v}`);
    return true;
  };
}
