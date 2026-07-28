export interface WorkerJobWatchdog {
  touch(): void;
  dispose(): void;
}

export function createWorkerJobWatchdog(
  timeoutMs: number,
  onTimeout: () => void,
): WorkerJobWatchdog {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Worker job watchdog timeout must be a positive duration");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) onTimeout();
    }, timeoutMs);
    timer.unref?.();
  };

  arm();
  return {
    touch() {
      if (!disposed) arm();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
