import { jobChanges } from './signal.js';

/** GET /api/jobs/:id?wait=…: at most this many seconds (spec 05a 5.1). */
export const MAX_JOB_WAIT_S = 30;
/** MCP get_job wait_seconds: below the time limit of common MCP clients. */
export const MAX_MCP_JOB_WAIT_S = 25;

/**
 * The job as `read` gives it: at once when its `change` differs from `change` (or no `change` was given); else after
 * its next change, after `waitMs`, or when `signal` aborts (client gone, server closing), whichever comes first.
 */
export async function waitForJobChange<T extends { change: string }>(
  read: () => T, change: string | undefined, waitMs: number, signal: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const view = read();
    const left = deadline - Date.now();
    if (change === undefined || view.change !== change || left <= 0 || signal.aborted) return view;
    // Any job's change wakes every waiter; one whose own job did not change waits on for the rest of its time.
    await jobChanges.wait(left, signal);
  }
}
