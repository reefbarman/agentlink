/**
 * Simple counting semaphore for limiting concurrency.
 *
 * Usage:
 *   const sem = new Semaphore(3); // max 3 concurrent
 *   const release = await sem.acquire();
 *   try { ... } finally { release(); }
 */
export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve(this.release.bind(this));
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this.release.bind(this)));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  /** Number of callers currently waiting to acquire. */
  get waiting(): number {
    return this.queue.length;
  }
}
