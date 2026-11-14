import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Spec 05a 4.2: fornax lease renews `alive` this often while its program runs. */
export const ALIVE_MS = 15_000;
/** Lease folders nothing touched for this long are leftovers of a crash: fornax lease and the lease tool sweep them. */
export const LEASE_LEFTOVER_MS = 86_400_000;

/**
 * The files fornax lease and the lease tool talk through, in <data>/leases/<job id>/. Both hold the started_at of the
 * claim they belong to: `alive` the claim fornax lease serves now, `done` the claim its program ran under. The tool
 * ends only on a `done` whose text equals `alive`'s, so a `done` of an earlier claim never ends a later one; it never
 * removes a stale `done`. Each file is written whole in one write, and `alive` always before `done`.
 */
export class LeaseFiles {
  readonly dir: string;

  constructor(leasesDir: string, jobId: string) {
    this.dir = join(leasesDir, jobId);
  }

  /** Create or renew `alive`; false when it cannot be written (the tool then ends the lease within a minute). */
  alive(startedAt: string): boolean {
    return this.write('alive', startedAt);
  }

  /** The program ended: the tool may end the lease. */
  done(startedAt: string): boolean {
    return this.write('done', startedAt);
  }

  private write(name: string, startedAt: string): boolean {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, name), startedAt);
      return true;
    } catch {
      return false;
    }
  }
}

/** The newest change of a lease folder: the folder itself or any file in it (renewing `alive` does not touch the folder). */
function newest(dir: string): number {
  let t = statSync(dir).mtimeMs;
  for (const name of readdirSync(dir)) {
    try {
      t = Math.max(t, statSync(join(dir, name)).mtimeMs);
    } catch {
      // Gone meanwhile.
    }
  }
  return t;
}

/**
 * Remove lease folders nothing touched for LEASE_LEFTOVER_MS. Never throws.
 * types/lease/scripts/lease.mjs mirrors this sweep (and `newest`): keep the two the same.
 */
export function sweepLeases(leasesDir: string, now: number = Date.now()): void {
  let entries;
  try {
    entries = readdirSync(leasesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(leasesDir, e.name);
    try {
      if (now - newest(dir) > LEASE_LEFTOVER_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Held or gone: a later sweep tries again.
    }
  }
}
