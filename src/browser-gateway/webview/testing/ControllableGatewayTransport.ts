export interface ControllableFetchRequest {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
  readonly signal: AbortSignal | undefined;
  readonly promise: Promise<Response>;
  readonly settled: boolean;
  respond(body: BodyInit | null, init?: ResponseInit): void;
  fail(error?: unknown): void;
}

interface MutableFetchRequest extends ControllableFetchRequest {
  settled: boolean;
}

export class ControllableFetch {
  readonly requests: ControllableFetchRequest[] = [];

  readonly fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let resolvePromise!: (response: Response) => void;
    let rejectPromise!: (error: unknown) => void;
    const signal = init?.signal ?? undefined;
    const promise = new Promise<Response>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const request: MutableFetchRequest = {
      input,
      init,
      signal,
      promise,
      settled: false,
      respond: (body, responseInit) => {
        if (request.settled) return;
        request.settled = true;
        resolvePromise(new Response(body, responseInit));
      },
      fail: (error = new Error("controllable_fetch_failed")) => {
        if (request.settled) return;
        request.settled = true;
        rejectPromise(error);
      },
    };
    const abort = () =>
      request.fail(new DOMException("The operation was aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.requests.push(request);
    return promise;
  };

  get pendingRequests(): readonly ControllableFetchRequest[] {
    return this.requests.filter((request) => !request.settled);
  }
}

export class ControllableEventSource {
  static readonly instances: ControllableEventSource[] = [];

  static reset(): void {
    this.instances.length = 0;
  }

  readonly listeners = new Map<
    string,
    Set<(event: MessageEvent<string>) => void>
  >();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCount = 0;
  readyState = 0;

  constructor(readonly url: string) {
    ControllableEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }

  fail(): void {
    this.readyState = 0;
    this.onerror?.();
  }

  close(): void {
    this.readyState = 2;
    this.closeCount += 1;
  }
}
