import type {
  ComposeRuntimeOptions,
  ComposeToolResult,
} from "./composeRuntime.js";

import type { ComposeTrace } from "@agentlink/protocol/compose";

export const COMPOSE_MAX_ACTIVE_RUNTIMES = 4;
export const COMPOSE_MAX_RUNTIME_WAITERS = 8;
export const COMPOSE_RUNTIME_ADMISSION_TIMEOUT_MS = 5_000;

interface ComposeRuntimeAdmissionOptions {
  maxActive?: number;
  maxWaiters?: number;
  admissionTimeoutMs?: number;
}

interface Waiter {
  options: ComposeRuntimeOptions;
  execute: () => Promise<ComposeToolResult>;
  resolve: (result: ComposeToolResult) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  abort: () => void;
  settled: boolean;
}

function terminalResult(
  options: ComposeRuntimeOptions,
  kind: "aborted" | "internal",
  errorCode: "aborted" | "compose_runtime_busy",
  message: string,
): ComposeToolResult {
  const trace: ComposeTrace = {
    description: options.params.description,
    status: kind === "aborted" ? "cancelled" : "error",
    children: [],
    totalChildren: 0,
    completedChildren: 0,
    succeededChildren: 0,
    failedChildren: 0,
    cancelledChildren: 0,
    toolAllBatchCount: 0,
    toolAllSettledBatchCount: 0,
    bridgedBytes: 0,
    errorKind: kind,
    errorCode,
  };
  const data = { error: message, kind, code: errorCode };
  return {
    data,
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: true,
    error: { kind, message },
    uiMeta: { composeTrace: trace },
  };
}

export class ComposeRuntimeLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly maxActive: number;
  private readonly maxWaiters: number;
  private readonly admissionTimeoutMs: number;

  constructor(options: ComposeRuntimeAdmissionOptions = {}) {
    this.maxActive = options.maxActive ?? COMPOSE_MAX_ACTIVE_RUNTIMES;
    this.maxWaiters = options.maxWaiters ?? COMPOSE_MAX_RUNTIME_WAITERS;
    this.admissionTimeoutMs =
      options.admissionTimeoutMs ?? COMPOSE_RUNTIME_ADMISSION_TIMEOUT_MS;
  }

  run(
    options: ComposeRuntimeOptions,
    execute: () => Promise<ComposeToolResult>,
  ): Promise<ComposeToolResult> {
    if (options.signal.aborted) {
      return Promise.resolve(
        terminalResult(
          options,
          "aborted",
          "aborted",
          "Compose execution was aborted",
        ),
      );
    }
    if (this.active < this.maxActive) return this.execute(execute);
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.resolve(this.busyResult(options));
    }

    return new Promise<ComposeToolResult>((resolve, reject) => {
      const waiter: Waiter = {
        options,
        execute,
        resolve,
        reject,
        timeout: undefined as unknown as ReturnType<typeof setTimeout>,
        abort: () => undefined,
        settled: false,
      };
      waiter.abort = () => {
        if (!this.removeWaiter(waiter)) return;
        this.settleWaiter(
          waiter,
          terminalResult(
            options,
            "aborted",
            "aborted",
            "Compose execution was aborted",
          ),
        );
      };
      waiter.timeout = setTimeout(() => {
        if (!this.removeWaiter(waiter)) return;
        this.settleWaiter(waiter, this.busyResult(options));
      }, this.admissionTimeoutMs);
      options.signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private busyResult(options: ComposeRuntimeOptions): ComposeToolResult {
    return terminalResult(
      options,
      "internal",
      "compose_runtime_busy",
      "Compose runtime capacity is busy; retry after other compose calls finish",
    );
  }

  private execute(
    execute: () => Promise<ComposeToolResult>,
  ): Promise<ComposeToolResult> {
    this.active += 1;
    return Promise.resolve()
      .then(execute)
      .finally(() => {
        this.active -= 1;
        this.dispatchNext();
      });
  }

  private dispatchNext(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    this.clearWaiter(waiter);
    void this.execute(waiter.execute).then(
      (result) => this.settleWaiter(waiter, result),
      (error: unknown) => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.reject(error);
      },
    );
  }

  private removeWaiter(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    this.clearWaiter(waiter);
    return true;
  }

  private clearWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timeout);
    waiter.options.signal.removeEventListener("abort", waiter.abort);
  }

  private settleWaiter(waiter: Waiter, result: ComposeToolResult): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.clearWaiter(waiter);
    waiter.resolve(result);
  }
}

const extensionHostLimiter = new ComposeRuntimeLimiter();

export function runWithComposeRuntimeAdmission(
  options: ComposeRuntimeOptions,
  execute: () => Promise<ComposeToolResult>,
): Promise<ComposeToolResult> {
  return extensionHostLimiter.run(options, execute);
}
