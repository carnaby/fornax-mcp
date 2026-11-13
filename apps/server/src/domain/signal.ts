/** Wakes long-polling claims in this process when a job may have become available. */
class JobSignal {
  private readonly waiters = new Set<() => void>();

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

export const jobSignal = new JobSignal();
