/** Wakes long-polling requests in this process. */
class JobSignal {
  private readonly waiters = new Set<() => void>();

  /** How many requests wait now (tests check that an ended request left nothing behind). */
  get waiting(): number {
    return this.waiters.size;
  }

  wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Resolves on wake(), after `ms`, or when `signal` aborts, whichever comes first. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** Wakes waiting claims when a job may have become available. */
export const jobSignal = new JobSignal();

/**
 * Wakes clients waiting for a job to change (GET /api/jobs/:id?wait, MCP get_job wait_seconds): every change of any
 * job, because a job's place in the queue moves when another job changes (spec 05a 5.1). Woken inside a transaction,
 * a waiter still reads after the commit: its promise continues only once the current synchronous code is done.
 */
export const jobChanges = new JobSignal();
