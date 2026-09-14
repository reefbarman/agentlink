import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkspaceMutationLease {
  readonly kind: "commit" | "exclusive";
  readonly released: boolean;
  release(): void;
}

interface PendingMutationRequest {
  readonly kind: "commit" | "exclusive";
  readonly resolve: (lease: WorkspaceMutationLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

/**
 * Coordinates short-lived file commits and exclusive mutating operations inside
 * one workspace host. A queued exclusive request blocks later commits so it
 * cannot starve behind a stream of file writes.
 */
interface ExclusiveExecution {
  lease: WorkspaceMutationLease | undefined;
  readonly signal?: AbortSignal;
}

export class WorkspaceMutationCoordinator {
  private activeCommits = 0;
  private exclusiveActive = false;
  private readonly pending: PendingMutationRequest[] = [];
  private readonly exclusiveExecution =
    new AsyncLocalStorage<ExclusiveExecution>();

  acquireCommit(signal?: AbortSignal): Promise<WorkspaceMutationLease> {
    return this.acquire("commit", signal);
  }

  acquireExclusive(signal?: AbortSignal): Promise<WorkspaceMutationLease> {
    return this.acquire("exclusive", signal);
  }

  async withCommit<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lease = await this.acquireCommit(signal);
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  async withExclusive<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const execution: ExclusiveExecution = {
      lease: await this.acquireExclusive(signal),
      ...(signal ? { signal } : {}),
    };
    try {
      return await this.exclusiveExecution.run(execution, operation);
    } finally {
      execution.lease?.release();
      execution.lease = undefined;
    }
  }

  /** Release an active exclusive lease while awaiting foreground authorization. */
  async outsideExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.exclusiveExecution.getStore();
    if (!execution?.lease) return await operation();
    execution.lease.release();
    execution.lease = undefined;
    try {
      return await operation();
    } finally {
      execution.lease = await this.acquireExclusive(execution.signal);
    }
  }

  private acquire(
    kind: "commit" | "exclusive",
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationLease> {
    if (signal?.aborted) {
      return Promise.reject(new Error("workspace_mutation_wait_cancelled"));
    }
    return new Promise<WorkspaceMutationLease>((resolve, reject) => {
      const request: PendingMutationRequest = {
        kind,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        settled: false,
      };
      if (signal) {
        request.onAbort = () => {
          const index = this.pending.indexOf(request);
          if (index !== -1) this.pending.splice(index, 1);
          this.rejectRequest(
            request,
            new Error("workspace_mutation_wait_cancelled"),
          );
          this.drain();
        };
        signal.addEventListener("abort", request.onAbort, { once: true });
      }
      this.pending.push(request);
      this.drain();
    });
  }

  private drain(): void {
    for (;;) {
      const first = this.pending[0];
      if (!first) return;
      if (first.signal?.aborted) {
        this.pending.shift();
        this.rejectRequest(
          first,
          new Error("workspace_mutation_wait_cancelled"),
        );
        continue;
      }
      if (first.kind === "exclusive") {
        if (this.exclusiveActive || this.activeCommits > 0) return;
        this.pending.shift();
        this.exclusiveActive = true;
        this.resolveRequest(first);
        return;
      }
      if (this.exclusiveActive) return;
      const exclusiveIndex = this.pending.findIndex(
        (request) => request.kind === "exclusive",
      );
      const commitLimit =
        exclusiveIndex === -1 ? this.pending.length : exclusiveIndex;
      if (commitLimit === 0) return;
      const admitted = this.pending.splice(0, commitLimit);
      for (const request of admitted) {
        if (request.kind !== "commit") {
          throw new Error("workspace_mutation_queue_corrupt");
        }
        this.activeCommits += 1;
        this.resolveRequest(request);
      }
      return;
    }
  }

  private resolveRequest(request: PendingMutationRequest): void {
    if (request.settled) return;
    request.settled = true;
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    let released = false;
    request.resolve({
      kind: request.kind,
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        if (request.kind === "exclusive") this.exclusiveActive = false;
        else this.activeCommits = Math.max(0, this.activeCommits - 1);
        this.drain();
      },
    });
  }

  private rejectRequest(request: PendingMutationRequest, error: Error): void {
    if (request.settled) return;
    request.settled = true;
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    request.reject(error);
  }
}
