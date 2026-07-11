export interface DiagnosticsQuiescenceDisposable {
  dispose(): void;
}

export interface DiagnosticsQuiescenceOptions<T> {
  delayMs: number;
  hadEvent?: boolean;
  subscribe(listener: () => void): DiagnosticsQuiescenceDisposable;
  collect(): T;
  eagerDisposables?: DiagnosticsQuiescenceDisposable[];
  debounceMs?: number;
  firstEventGraceMs?: number;
}

export function waitForDiagnosticsQuiescence<T>(
  options: DiagnosticsQuiescenceOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let eventObserved = options.hadEvent ?? false;
    const debounceMs = options.debounceMs ?? 300;
    const firstEventGraceMs =
      options.firstEventGraceMs ?? Math.min(options.delayMs, 500);

    const settle = () => {
      if (settled) return;
      settled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
      subscription.dispose();
      for (const disposable of options.eagerDisposables ?? []) {
        disposable.dispose();
      }
      resolve(options.collect());
    };

    const onEvent = () => {
      if (settled) return;
      eventObserved = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(settle, debounceMs);
    };

    const subscription = options.subscribe(onEvent);

    if (eventObserved) {
      debounceTimer ??= setTimeout(settle, debounceMs);
    } else {
      graceTimer = setTimeout(settle, firstEventGraceMs);
    }
    hardTimeoutTimer = setTimeout(settle, options.delayMs);
  });
}
