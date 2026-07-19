export type ModelRequestPriority = "interactive" | "background" | "maintenance";

export interface ModelRequestPermit {
  queued: boolean;
  waitMs: number;
  release(): void;
}

interface PendingRequest {
  sequence: number;
  priority: ModelRequestPriority;
  enqueuedAt: number;
  signal?: AbortSignal;
  resolve: (permit: ModelRequestPermit) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface ProviderQueue {
  active: number;
  pending: PendingRequest[];
}

const PRIORITY_ORDER: Record<ModelRequestPriority, number> = {
  interactive: 0,
  background: 1,
  maintenance: 2,
};

export const DEFAULT_MAX_CONCURRENT_MODEL_REQUESTS_PER_PROVIDER = 2;

/**
 * Admission control shared by all model requests using one provider registry.
 * Active requests are never preempted; queued work is admitted by priority and
 * then FIFO order so foreground turns do not sit behind background maintenance.
 */
export class ModelRequestScheduler {
  private readonly queues = new Map<string, ProviderQueue>();
  private sequence = 0;

  constructor(
    private readonly maxConcurrentPerProvider = DEFAULT_MAX_CONCURRENT_MODEL_REQUESTS_PER_PROVIDER,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isInteger(maxConcurrentPerProvider) ||
      maxConcurrentPerProvider < 1
    ) {
      throw new Error("maxConcurrentPerProvider must be a positive integer");
    }
  }

  hasCapacity(
    providerId: string,
    priority: ModelRequestPriority = "background",
  ): boolean {
    return this.canAdmit(this.getQueue(providerId), priority);
  }

  acquire(
    providerId: string,
    priority: ModelRequestPriority,
    signal?: AbortSignal,
  ): Promise<ModelRequestPermit> {
    if (signal?.aborted) {
      return Promise.reject(this.abortError());
    }

    const queue = this.getQueue(providerId);
    if (this.canAdmit(queue, priority)) {
      queue.active += 1;
      return Promise.resolve(this.createPermit(providerId, false, 0));
    }

    const enqueuedAt = this.now();
    return new Promise<ModelRequestPermit>((resolve, reject) => {
      const pending: PendingRequest = {
        sequence: this.sequence++,
        priority,
        enqueuedAt,
        signal,
        resolve,
        reject,
      };
      if (signal) {
        pending.onAbort = () => {
          const index = queue.pending.indexOf(pending);
          if (index >= 0) queue.pending.splice(index, 1);
          reject(this.abortError());
          this.deleteEmptyQueue(providerId, queue);
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      queue.pending.push(pending);
    });
  }

  private getQueue(providerId: string): ProviderQueue {
    const existing = this.queues.get(providerId);
    if (existing) return existing;
    const created = { active: 0, pending: [] };
    this.queues.set(providerId, created);
    return created;
  }

  private createPermit(
    providerId: string,
    queued: boolean,
    waitMs: number,
  ): ModelRequestPermit {
    let released = false;
    return {
      queued,
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        this.release(providerId);
      },
    };
  }

  private release(providerId: string): void {
    const queue = this.queues.get(providerId);
    if (!queue) return;
    queue.active = Math.max(0, queue.active - 1);
    this.drain(providerId, queue);
  }

  private drain(providerId: string, queue: ProviderQueue): void {
    while (
      queue.active < this.maxConcurrentPerProvider &&
      queue.pending.length > 0
    ) {
      queue.pending.sort(
        (left, right) =>
          PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
          left.sequence - right.sequence,
      );
      const pending = queue.pending[0]!;
      if (!this.canAdmit(queue, pending.priority)) break;
      queue.pending.shift();
      if (pending.signal?.aborted) {
        pending.signal.removeEventListener("abort", pending.onAbort!);
        pending.reject(this.abortError());
        continue;
      }
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      queue.active += 1;
      pending.resolve(
        this.createPermit(
          providerId,
          true,
          Math.max(0, this.now() - pending.enqueuedAt),
        ),
      );
    }
    this.deleteEmptyQueue(providerId, queue);
  }

  private deleteEmptyQueue(providerId: string, queue: ProviderQueue): void {
    if (queue.active === 0 && queue.pending.length === 0) {
      this.queues.delete(providerId);
    }
  }

  private canAdmit(
    queue: ProviderQueue,
    priority: ModelRequestPriority,
  ): boolean {
    if (queue.active >= this.maxConcurrentPerProvider) return false;
    // Status summarization and other maintenance should never consume provider
    // capacity alongside user-visible work. It runs only when the provider is
    // otherwise idle, then yields to queued foreground/background requests.
    if (priority === "maintenance") {
      return (
        queue.active === 0 &&
        !queue.pending.some((item) => item.priority !== "maintenance")
      );
    }
    return true;
  }

  private abortError(): Error {
    return new DOMException("Model request admission aborted", "AbortError");
  }
}
