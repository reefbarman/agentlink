export interface AskAgentSnapshotPublication<TSnapshot> {
  readonly revision: number;
  readonly snapshot: TSnapshot;
  readonly serialized: string;
  readonly bytes: number;
}

export interface AskAgentSnapshotPublicationQueueOptions<TSnapshot> {
  coalesceMs: number;
  publish(
    publication: AskAgentSnapshotPublication<TSnapshot>,
  ): void | Promise<void>;
  serialize?: (snapshot: TSnapshot) => string;
  byteLength?: (serialized: string) => number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type PublicationWaiter<TSnapshot> = {
  resolve: (publication: AskAgentSnapshotPublication<TSnapshot>) => void;
  reject: (error: unknown) => void;
};

type PublicationRequest<TSnapshot> = {
  sequence: number;
  build: () => TSnapshot | Promise<TSnapshot>;
  supersedable: boolean;
  waiters: PublicationWaiter<TSnapshot>[];
};

export class AskAgentSnapshotPublicationQueue<TSnapshot> {
  private readonly serialize: (snapshot: TSnapshot) => string;
  private readonly byteLength: (serialized: string) => number;
  private readonly setTimer: NonNullable<
    AskAgentSnapshotPublicationQueueOptions<TSnapshot>["setTimer"]
  >;
  private readonly clearTimer: NonNullable<
    AskAgentSnapshotPublicationQueueOptions<TSnapshot>["clearTimer"]
  >;
  private nextSequence = 0;
  private revision = 0;
  private readonly requests: PublicationRequest<TSnapshot>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private lastPublication: AskAgentSnapshotPublication<TSnapshot> | null = null;
  private disposed = false;

  constructor(
    private readonly options: AskAgentSnapshotPublicationQueueOptions<TSnapshot>,
  ) {
    this.serialize = options.serialize ?? JSON.stringify;
    this.byteLength =
      options.byteLength ??
      ((serialized) => Buffer.byteLength(serialized, "utf8"));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  schedule(
    build: () => TSnapshot | Promise<TSnapshot>,
  ): Promise<AskAgentSnapshotPublication<TSnapshot>> {
    const result = this.enqueue(build, true);
    if (!this.timer && !this.drainPromise) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        void this.startDrain();
      }, this.options.coalesceMs);
    }
    return result;
  }

  publishNow(
    build: () => TSnapshot | Promise<TSnapshot>,
  ): Promise<AskAgentSnapshotPublication<TSnapshot>> {
    const result = this.enqueue(build, false);
    this.cancelTimer();
    void this.startDrain();
    return result;
  }

  async flush(): Promise<AskAgentSnapshotPublication<TSnapshot> | null> {
    this.cancelTimer();
    do {
      await this.startDrain();
    } while (this.requests.length > 0 || this.drainPromise);
    return this.lastPublication;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.flush();
    this.disposed = true;
  }

  private enqueue(
    build: () => TSnapshot | Promise<TSnapshot>,
    supersedable: boolean,
  ): Promise<AskAgentSnapshotPublication<TSnapshot>> {
    if (this.disposed) {
      return Promise.reject(new Error("ask_agent_snapshot_queue_disposed"));
    }
    const sequence = ++this.nextSequence;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const lastRequest = this.requests.at(-1);
      if (supersedable && lastRequest?.supersedable) {
        lastRequest.sequence = sequence;
        lastRequest.build = build;
        lastRequest.waiters.push(waiter);
        return;
      }
      if (!supersedable && lastRequest?.supersedable) {
        this.requests.pop();
        this.requests.push({
          sequence,
          build,
          supersedable: false,
          waiters: [...lastRequest.waiters, waiter],
        });
        return;
      }
      this.requests.push({ sequence, build, supersedable, waiters: [waiter] });
    });
  }

  private startDrain(): Promise<void> {
    this.drainPromise ??= this.drain().finally(() => {
      this.drainPromise = null;
      if (this.requests.length > 0 && !this.timer && !this.disposed) {
        void this.startDrain();
      }
    });
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    while (this.requests.length > 0) {
      const request = this.requests.shift()!;
      try {
        const snapshot = await request.build();
        if (this.transferStaleWaiters(request)) continue;
        const serialized = this.serialize(snapshot);
        const publication: AskAgentSnapshotPublication<TSnapshot> = {
          revision: ++this.revision,
          snapshot,
          serialized,
          bytes: this.byteLength(serialized),
        };
        await this.options.publish(publication);
        this.lastPublication = publication;
        for (const waiter of request.waiters) waiter.resolve(publication);
      } catch (error) {
        if (this.transferStaleWaiters(request)) continue;
        for (const waiter of request.waiters) waiter.reject(error);
      }
    }
  }

  private transferStaleWaiters(
    request: PublicationRequest<TSnapshot>,
  ): boolean {
    if (!request.supersedable || this.requests.length === 0) return false;
    this.requests.at(-1)!.waiters.unshift(...request.waiters);
    return true;
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
