export class TerminalAdmissionCancelledError extends Error {
  constructor(message = "Terminal admission was cancelled") {
    super(message);
    this.name = "TerminalAdmissionCancelledError";
  }
}

export interface TerminalAdmissionTicket {
  consume(): void;
  release(): void;
}

interface TerminalAdmissionWaiter {
  resolve(ticket: TerminalAdmissionTicket): void;
  reject(error: Error): void;
  canAdmit(): boolean;
  timeoutError(): Error;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  granted: boolean;
  settled: boolean;
}

export interface TerminalAdmissionRequest {
  key: string;
  canAdmit(): boolean;
  timeoutError(): Error;
  signal?: AbortSignal;
  timeoutMs: number;
  maxWaiters: number;
}

export class TerminalAdmissionQueue {
  private readonly waiters = new Map<string, TerminalAdmissionWaiter[]>();
  private retired = false;

  get waiting(): number {
    return [...this.waiters.values()].reduce(
      (count, waiters) => count + waiters.length,
      0,
    );
  }

  hasPending(key: string): boolean {
    return this.waitingFor(key) > 0;
  }

  waitingFor(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }

  async wait(
    request: TerminalAdmissionRequest,
  ): Promise<TerminalAdmissionTicket> {
    if (this.retired) {
      throw new TerminalAdmissionCancelledError(
        "Terminal provider was retired",
      );
    }
    if (request.signal?.aborted) throw new TerminalAdmissionCancelledError();

    return new Promise<TerminalAdmissionTicket>((resolve, reject) => {
      const waiter: TerminalAdmissionWaiter = {
        resolve,
        reject,
        canAdmit: request.canAdmit,
        timeoutError: request.timeoutError,
        signal: request.signal,
        granted: false,
        settled: false,
      };
      const waiters = this.waiters.get(request.key) ?? [];
      if (waiters.length >= request.maxWaiters) {
        reject(request.timeoutError());
        return;
      }
      waiters.push(waiter);
      this.waiters.set(request.key, waiters);
      waiter.abort = () =>
        this.remove(request.key, waiter, new TerminalAdmissionCancelledError());
      request.signal?.addEventListener("abort", waiter.abort, { once: true });
      waiter.timeout = setTimeout(
        () => this.remove(request.key, waiter, waiter.timeoutError()),
        request.timeoutMs,
      );
      waiter.timeout.unref();
      this.pump(request.key);
    });
  }

  notify(key: string): void {
    this.pump(key);
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const [key, waiters] of this.waiters) {
      while (waiters[0]) {
        this.remove(
          key,
          waiters[0],
          new TerminalAdmissionCancelledError("Terminal provider was retired"),
        );
      }
    }
  }

  private pump(key: string): void {
    if (this.retired) return;
    const waiter = this.waiters.get(key)?.[0];
    if (!waiter || waiter.granted || !waiter.canAdmit()) return;
    waiter.granted = true;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    waiter.timeout = undefined;
    waiter.resolve({
      consume: () => this.remove(key, waiter),
      release: () => this.remove(key, waiter),
    });
  }

  private remove(
    key: string,
    waiter: TerminalAdmissionWaiter,
    error?: Error,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    const waiters = this.waiters.get(key);
    if (waiters) {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      if (waiters.length === 0) this.waiters.delete(key);
    }
    if (error) waiter.reject(error);
    this.pump(key);
  }
}
