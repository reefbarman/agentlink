import { randomId } from "../shared/randomId.js";

export type McpResourceWatchMode = "notify" | "deliver" | "wake";

/** Metadata only. Resource bodies must never enter a persisted UI snapshot. */
export interface McpResourceWatchState {
  server: string;
  uri: string;
  mode: McpResourceWatchMode;
  paused: boolean;
  reason?: string;
  pending: boolean;
  updatedAt?: number;
}

export interface McpResourceUpdate {
  readonly id: string;
  readonly server: string;
  readonly uri: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly grantGeneration: number;
}

export interface McpResourceUpdateBatch {
  readonly id: string;
  readonly idle: boolean;
  readonly updates: readonly McpResourceUpdate[];
}

export interface McpResourceWatchSubscriptionHandlers {
  onUpdated(uri: string): void;
  onError(error: unknown): void;
  /** Called only after the transport has restored the same subscription. */
  onReconnected(): void;
}

export interface McpResourceWatchesOptions {
  getServerIdentity(server: string): string | undefined;
  requestApproval(request: {
    server: string;
    uri: string;
    mode: McpResourceWatchMode;
  }): Promise<McpResourceWatchMode | "deny">;
  subscribe(
    server: string,
    uris: readonly string[],
    handlers: McpResourceWatchSubscriptionHandlers,
  ): Promise<{ dispose(): Promise<void> }>;
  /** Host enforces current server policy and performs non-interactive, text-only reads. */
  read(
    server: string,
    uri: string,
    signal: AbortSignal,
  ): Promise<{ text: string } | { error: string }>;
  onChange(): void;
  /** Scheduler hint only, never authority to start a run. */
  onPending(): void;
  now?: () => number;
}

export type McpResourceWatchResult =
  | { ok: true; watch: McpResourceWatchState }
  | { ok: false; error: string };

type Suspension =
  | "approval"
  | "identity"
  | "manual"
  | "stop"
  | "budget"
  | "error";
interface Watch {
  server: string;
  uri: string;
  identity: string;
  mode: McpResourceWatchMode;
  generation: number;
  granted: boolean;
  suspension?: Suspension;
  reason?: string;
  updatedAt?: number;
  notice: boolean;
  dirty: boolean;
  pending?: McpResourceUpdate;
  delivered?: string;
  abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
interface ServerSubscription {
  key: string;
  epoch: number;
  ready: boolean;
  handle?: { dispose(): Promise<void> };
  work: Promise<void>;
}

const rank: Record<McpResourceWatchMode, number> = {
  notify: 0,
  deliver: 1,
  wake: 2,
};
const encoder = new TextEncoder();
const AUTOMATIC_LIMIT = "Paused, automatic-update limit reached";

/**
 * One loaded session's in-memory grants and latest-snapshot queue. No grant is inherited or persisted.
 * Hosts must recheck isBatchValid immediately before synchronous transcript admission, then commit.
 * A reservation is not permission to bypass host run-state, approval or question gates.
 */
export class McpResourceWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly servers = new Map<string, ServerSubscription>();
  private readonly lastReads = new Map<string, number>();
  private readTimes: number[] = [];
  private wakeTimes: number[] = [];
  private generation = 0;
  private serial = 0;
  private readonly deliveryNamespace = randomId();
  private admissions = 0;
  private reservation?: McpResourceUpdateBatch;
  private disposed = false;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: McpResourceWatchesOptions) {
    this.now = options.now ?? Date.now;
  }

  async watch(
    server: string,
    uri: string,
    mode: McpResourceWatchMode,
  ): Promise<McpResourceWatchResult> {
    this.refresh();
    if (this.disposed) return { ok: false, error: "Session is closed" };
    if (!server || !uri || !(mode in rank))
      return { ok: false, error: "Invalid watch request" };
    const identity = this.options.getServerIdentity(server);
    if (identity === undefined)
      return { ok: false, error: "Server is unavailable" };
    const key = this.key(server, uri);
    let watch = this.watches.get(key);
    if (watch?.granted && watch.suspension !== "approval") {
      if (watch.mode === mode) return { ok: true, watch: this.state(watch) };
      if (rank[mode] < rank[watch.mode]) {
        this.invalidate(watch);
        watch.mode = mode;
        watch.delivered = undefined;
        this.changed();
        this.catchUp(watch);
        return { ok: true, watch: this.state(watch) };
      }
    }
    if (!watch && this.watches.size >= 4)
      return { ok: false, error: "Maximum four resource watches" };
    if (!watch) {
      watch = {
        server,
        uri,
        identity,
        mode,
        generation: ++this.generation,
        granted: false,
        notice: false,
        dirty: false,
      };
      this.watches.set(key, watch);
    }
    this.invalidate(watch);
    watch.identity = identity;
    watch.mode = mode;
    watch.granted = false;
    watch.delivered = undefined;
    watch.suspension = "approval";
    watch.reason = "Approval required";
    const generation = watch.generation;
    this.syncServer(server);
    this.changed();
    let approved: McpResourceWatchMode | "deny";
    try {
      approved = await this.options.requestApproval({ server, uri, mode });
    } catch {
      approved = "deny";
    }
    if (
      !this.current(watch, generation) ||
      this.options.getServerIdentity(server) !== identity
    ) {
      this.refresh();
      return { ok: false, error: "Watch request is no longer current" };
    }
    if (approved === "deny" || !(approved in rank)) {
      this.watches.delete(key);
      this.syncServer(server);
      this.changed();
      return { ok: false, error: "Resource watch denied" };
    }
    watch.mode = approved;
    watch.granted = true;
    watch.suspension = undefined;
    watch.reason = undefined;
    if (this.stopped) this.suspend(watch, "stop", "Session stopped");
    // Creating/upgrading a watch is not a human-turn budget reset.
    else if (this.admissions >= 3 && approved !== "notify")
      this.suspend(watch, "budget", AUTOMATIC_LIMIT);
    this.syncServer(server);
    this.changed();
    if (this.servers.get(server)?.ready) this.catchUp(watch);
    return { ok: true, watch: this.state(watch) };
  }

  unwatch(server: string, uri: string): boolean {
    const watch = this.watches.get(this.key(server, uri));
    if (!watch) return false;
    this.invalidate(watch);
    this.watches.delete(this.key(server, uri));
    this.syncServer(server);
    this.changed();
    return true;
  }

  pause(server: string, uri: string): boolean {
    this.refresh();
    const watch = this.watches.get(this.key(server, uri));
    if (!watch?.granted) return false;
    this.suspend(watch, "manual", "Paused by user");
    this.changed();
    return true;
  }

  /** Explicit human action only. It cannot recreate a revoked/server-replaced grant. */
  resume(server: string, uri: string): boolean {
    this.refresh();
    const watch = this.watches.get(this.key(server, uri));
    if (!watch?.granted) return false;
    this.stopped = false;
    this.admissions = 0;
    watch.suspension = undefined;
    watch.reason = undefined;
    this.syncServer(server, true);
    this.changed();
    return true;
  }

  /** Genuine user input only, never an automatic turn, tool reply or approval response. */
  noteUserTurn(): void {
    if (this.disposed) return;
    this.refresh();
    this.stopped = false;
    this.admissions = 0;
    // A genuine user start wins over a reserved idle wake, retaining its pending content.
    if (this.reservation?.idle) this.reservation = undefined;
    for (const watch of this.watches.values()) {
      if (
        watch.granted &&
        (watch.suspension === "stop" || watch.suspension === "budget")
      ) {
        watch.suspension = undefined;
        watch.reason = undefined;
        this.catchUp(watch);
      }
    }
    this.changed();
    if ([...this.watches.values()].some((watch) => watch.pending))
      this.options.onPending();
  }

  /** Explicit session Stop. Manual/error/approval suspensions retain their stronger reason. */
  pauseAll(): void {
    this.stopped = true;
    for (const watch of this.watches.values()) {
      if (watch.suspension === "approval") this.invalidate(watch);
      if (!watch.suspension) this.suspend(watch, "stop", "Session stopped");
    }
    this.reservation = undefined;
    this.changed();
  }

  /** Call when server configuration/availability changes, even without a notification. */
  refresh(): void {
    if (this.disposed) return;
    let changed = false;
    for (const watch of this.watches.values()) {
      if (
        watch.suspension !== "identity" &&
        this.options.getServerIdentity(watch.server) !== watch.identity
      ) {
        this.suspend(
          watch,
          "identity",
          "Server changed or unavailable, approval required",
        );
        watch.granted = false;
        this.syncServer(watch.server);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  snapshot(): McpResourceWatchState[] {
    this.refresh();
    return [...this.watches.values()].map((watch) => this.state(watch));
  }

  /** Synchronous reservation. Failed idle attempts still spend the wake-rate allowance. */
  reservePending({
    idle,
  }: {
    idle: boolean;
  }): McpResourceUpdateBatch | undefined {
    this.refresh();
    if (this.disposed || this.reservation) return undefined;
    if (this.admissions >= 3) {
      this.pauseBudget();
      return undefined;
    }
    const updates = [...this.watches.values()]
      .filter(
        (watch) => this.canRead(watch) && (!idle || watch.mode === "wake"),
      )
      .flatMap((watch) => (watch.pending ? [watch.pending] : []));
    if (!updates.length) return undefined;
    if (idle) {
      const now = this.now();
      this.wakeTimes = this.wakeTimes.filter((time) => now - time < 3_600_000);
      if (
        this.wakeTimes.length >= 6 ||
        this.wakeTimes.some((time) => now - time < 300_000)
      ) {
        for (const watch of this.watches.values()) {
          if (watch.mode === "wake" && !watch.suspension) {
            this.suspend(
              watch,
              "budget",
              "Paused, automatic-wake limit reached",
            );
          }
        }
        this.changed();
        return undefined;
      }
      this.wakeTimes.push(now);
    }
    const batch: McpResourceUpdateBatch = Object.freeze({
      id: `mcp-batch-${this.deliveryNamespace}-${++this.serial}`,
      idle,
      updates: Object.freeze(updates),
    });
    this.reservation = batch;
    return batch;
  }

  isBatchValid(batch: McpResourceUpdateBatch): boolean {
    this.refresh();
    return (
      !this.disposed &&
      this.reservation === batch &&
      this.admissions < 3 &&
      batch.updates.every((update) => {
        const watch = this.watches.get(this.key(update.server, update.uri));
        return (
          watch !== undefined &&
          this.canRead(watch) &&
          (!batch.idle || watch.mode === "wake") &&
          watch.generation === update.grantGeneration &&
          watch.pending === update
        );
      })
    );
  }

  /** Call only after the host has synchronously committed these updates to the transcript. */
  commitPending(batch: McpResourceUpdateBatch): boolean {
    if (!this.isBatchValid(batch)) return false;
    for (const update of batch.updates) {
      const watch = this.watches.get(this.key(update.server, update.uri))!;
      watch.delivered = update.text;
      watch.pending = undefined;
      watch.notice = false;
    }
    this.reservation = undefined;
    this.admissions++;
    if (this.admissions >= 3) this.pauseBudget();
    else this.changed();
    return true;
  }

  releasePending(batch: McpResourceUpdateBatch): void {
    if (this.reservation === batch) this.reservation = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.reservation = undefined;
    for (const watch of this.watches.values()) this.invalidate(watch);
    this.watches.clear();
    for (const server of this.servers.keys()) this.syncServer(server);
    await Promise.all([...this.servers.values()].map((server) => server.work));
    this.servers.clear();
  }

  private key(server: string, uri: string): string {
    return JSON.stringify([server, uri]);
  }

  private current(watch: Watch, generation: number): boolean {
    return (
      !this.disposed &&
      this.watches.get(this.key(watch.server, watch.uri)) === watch &&
      watch.generation === generation
    );
  }

  private state(watch: Watch): McpResourceWatchState {
    return {
      server: watch.server,
      uri: watch.uri,
      mode: watch.mode,
      paused: watch.suspension !== undefined,
      ...(watch.reason ? { reason: watch.reason } : {}),
      pending: watch.notice || watch.pending !== undefined,
      ...(watch.updatedAt === undefined ? {} : { updatedAt: watch.updatedAt }),
    };
  }

  private changed(): void {
    if (!this.disposed) this.options.onChange();
  }

  private invalidate(watch: Watch): void {
    watch.generation = ++this.generation;
    watch.abort?.abort();
    watch.abort = undefined;
    if (watch.timer !== undefined) clearTimeout(watch.timer);
    watch.timer = undefined;
    watch.dirty = false;
    watch.pending = undefined;
    if (
      this.reservation?.updates.some(
        (update) => update.server === watch.server && update.uri === watch.uri,
      )
    ) {
      this.reservation = undefined;
    }
  }

  private suspend(watch: Watch, suspension: Suspension, reason: string): void {
    this.invalidate(watch);
    watch.suspension = suspension;
    watch.reason = reason;
  }

  private pauseBudget(): void {
    for (const watch of this.watches.values()) {
      if (watch.granted && watch.mode !== "notify" && !watch.suspension) {
        this.suspend(watch, "budget", AUTOMATIC_LIMIT);
      }
    }
    this.changed();
  }

  private canRead(watch: Watch): boolean {
    return (
      !this.disposed &&
      watch.granted &&
      !watch.suspension &&
      watch.mode !== "notify"
    );
  }

  private syncServer(server: string, force = false): void {
    const uris = [...this.watches.values()]
      .filter((watch) => watch.server === server && watch.granted)
      .map((watch) => watch.uri)
      .sort();
    const key = JSON.stringify(uris);
    let slot = this.servers.get(server);
    if (!slot) {
      slot = { key: "[]", epoch: 0, ready: false, work: Promise.resolve() };
      this.servers.set(server, slot);
    }
    if (slot.key === key && !force) return;
    slot.key = key;
    slot.ready = false;
    const epoch = ++slot.epoch;
    const subscription = slot;
    const current = () => !this.disposed && subscription.epoch === epoch;
    subscription.work = subscription.work.then(async () => {
      const previous = subscription.handle;
      subscription.handle = undefined;
      if (previous) {
        try {
          await previous.dispose();
        } catch {
          // Disposal is best effort; the epoch already rejects the old callbacks.
        }
      }
      if (!current() || !uris.length) return;
      try {
        const handle = await this.options.subscribe(server, uris, {
          onUpdated: (uri) => {
            if (!current() || !uris.includes(uri)) return;
            this.refresh();
            const watch = this.watches.get(this.key(server, uri));
            if (!current() || !watch?.granted) return;
            watch.updatedAt = this.now();
            watch.notice = true;
            watch.dirty = true;
            this.changed();
            if (subscription.ready) this.pump(watch);
          },
          onError: () => {
            if (!current()) return;
            for (const watch of this.watches.values()) {
              if (
                watch.server === server &&
                watch.granted &&
                !watch.suspension
              ) {
                this.suspend(
                  watch,
                  "error",
                  "Action required: resource subscription failed",
                );
              }
            }
            this.changed();
          },
          onReconnected: () => {
            if (!current()) return;
            this.refresh();
            if (!current()) return;
            for (const watch of this.watches.values()) {
              if (watch.server === server) this.catchUp(watch);
            }
          },
        });
        this.refresh();
        if (!current()) {
          await handle.dispose();
          return;
        }
        subscription.handle = handle;
        subscription.ready = true;
        for (const watch of this.watches.values()) {
          if (watch.server === server) this.catchUp(watch);
        }
      } catch {
        if (!current()) return;
        for (const watch of this.watches.values()) {
          if (watch.server === server && watch.granted && !watch.suspension) {
            this.suspend(
              watch,
              "error",
              "Action required: resource subscription failed",
            );
          }
        }
        this.changed();
      }
    });
  }

  private catchUp(watch: Watch): void {
    if (!this.canRead(watch)) return;
    watch.dirty = true;
    this.pump(watch);
  }

  private pump(watch: Watch): void {
    this.refresh();
    if (
      !this.canRead(watch) ||
      !watch.dirty ||
      watch.abort ||
      watch.timer !== undefined
    )
      return;
    if (!this.servers.get(watch.server)?.ready) return;
    const now = this.now();
    this.readTimes = this.readTimes.filter((time) => now - time < 60_000);
    const lastRead = this.lastReads.get(this.key(watch.server, watch.uri));
    const due = Math.max(
      lastRead === undefined ? now : lastRead + 5_000,
      this.readTimes.length >= 6 ? this.readTimes[0]! + 60_000 : now,
    );
    if (due > now) {
      const generation = watch.generation;
      watch.timer = setTimeout(() => {
        watch.timer = undefined;
        if (this.current(watch, generation)) this.pump(watch);
      }, due - now);
      return;
    }
    watch.dirty = false;
    const abort = new AbortController();
    const generation = watch.generation;
    watch.abort = abort;
    this.readTimes.push(now);
    this.lastReads.set(this.key(watch.server, watch.uri), now);
    void this.read(watch, generation, abort);
  }

  private async read(
    watch: Watch,
    generation: number,
    abort: AbortController,
  ): Promise<void> {
    try {
      const result = await this.options.read(
        watch.server,
        watch.uri,
        abort.signal,
      );
      this.refresh();
      if (
        !this.current(watch, generation) ||
        !this.canRead(watch) ||
        abort.signal.aborted
      )
        return;
      if ("error" in result) {
        this.suspend(
          watch,
          "error",
          `Action required: ${result.error.slice(0, 512) || "resource read failed"}`,
        );
        this.changed();
        return;
      }
      if (typeof result.text !== "string") {
        this.suspend(
          watch,
          "error",
          "Action required: unsupported resource content",
        );
        this.changed();
        return;
      }
      const bytes = encoder.encode(result.text).byteLength;
      const queued = [...this.watches.values()].reduce(
        (sum, other) =>
          sum +
          (other !== watch && other.pending
            ? encoder.encode(other.pending.text).byteLength
            : 0),
        0,
      );
      if (bytes > 65_536 || queued + bytes > 131_072) {
        this.suspend(
          watch,
          "error",
          "Action required: resource content limit exceeded",
        );
        this.changed();
        return;
      }
      watch.updatedAt = this.now();
      if (!result.text || result.text === watch.delivered) {
        watch.pending = undefined;
        watch.notice = false;
      } else if (watch.pending?.text !== result.text) {
        watch.pending = Object.freeze({
          id: `mcp-update-${this.deliveryNamespace}-${++this.serial}`,
          server: watch.server,
          uri: watch.uri,
          text: result.text,
          receivedAt: this.now(),
          grantGeneration: generation,
        });
      }
      this.changed();
      if (watch.pending) this.options.onPending();
    } catch {
      this.refresh();
      if (this.current(watch, generation) && !abort.signal.aborted) {
        this.suspend(watch, "error", "Action required: resource read failed");
        this.changed();
      }
    } finally {
      if (this.current(watch, generation) && watch.abort === abort) {
        watch.abort = undefined;
        this.pump(watch);
      }
    }
  }
}
