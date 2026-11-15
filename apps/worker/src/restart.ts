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

/**
 * What the restart file holds: none (no file); unreadable (a read error such as a file held by another program: read
 * again later, never removed); damaged (content that is no request, e.g. written by hand); or a request.
 */
export type RestartRequest = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'damaged' } | { kind: 'request'; version: string };

/** Read the restart file; never throws. */
export function readRestartRequest(paths: Paths): RestartRequest {
  let text: string;
  try {
    text = readFileSync(paths.restartFile, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
  }
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === 'string' && VERSION_TEXT.test(v) ? { kind: 'request', version: v } : { kind: 'damaged' };
  } catch {
    return { kind: 'damaged' };
  }
}

/** The worker child's exit code for "start me again" (spec 05c 5.1); the supervisor runs it again. */
export const RESTART_EXIT = 75;

/**
 * Spec 05c 5.2: asked between jobs. True means restart now (the request is removed and the line printed). A request
 * for the version this worker is, or a damaged file, is removed; a copy outside app (running from `runsFrom`) says
 * once what to do and keeps it. A file that cannot be read or removed (held by another program) never stops the
 * worker: the next round tries again, and after a restart the new child sees its own version and removes it.
 */
export function restartCheck(
  paths: Paths,
  o: {
    version: string;
    installed: boolean;
    /** The folder of the running fornax.mjs. */
    runsFrom: string;
    out: (line: string) => void;
    /** Test seam (default rmSync, force). */
    remove?: (file: string) => void;
  },
): () => boolean {
  const remove = () => {
    try {
      (o.remove ?? ((f: string) => rmSync(f, { force: true })))(paths.restartFile);
    } catch {
      // Tried again next round.
    }
  };
  let told = false;
  return () => {
    const r = readRestartRequest(paths);
    if (r.kind === 'none' || r.kind === 'unreadable') return false;
    if (r.kind === 'damaged' || r.version === o.version) {
      remove();
      return false;
    }
    if (!o.installed) {
      if (!told) o.out(`fornax ${r.version} is installed in ${paths.appDir}; this worker runs from ${o.runsFrom}: stop it and run fornax worker`);
      told = true;
      return false;
    }
    remove();
    o.out(`restarting for fornax ${r.version}`);
    return true;
  };
}
