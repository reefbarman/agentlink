import {
  GithubReleaseClient,
  ReleaseRateLimitError,
  type ReleaseDiscovery,
} from "./githubReleaseClient.js";
import {
  compareReleaseVersions,
  expectedReleaseAsset,
  parseReleaseVersion,
  selectReleaseUpdate,
} from "./releaseSelection.js";
import {
  ReleaseUpdateStore,
  type ReleaseUpdateCache,
} from "./releaseUpdateStore.js";
import type {
  ReleaseUpdateIdentity,
  ReleaseUpdateState,
} from "./releaseUpdateTypes.js";

const DAY = 24 * 60 * 60_000;

export interface ReleaseUpdateServiceOptions {
  identity: ReleaseUpdateIdentity;
  storageDirectory: string;
  automaticChecks: boolean;
  saveAutomaticChecks?: (value: boolean) => Promise<void>;
  client?: Pick<GithubReleaseClient, "discover">;
  store?: ReleaseUpdateStore;
  now?: () => number;
}

export class ReleaseUpdateService {
  private state: ReleaseUpdateState;
  private readonly store: ReleaseUpdateStore;
  private readonly client: Pick<GithubReleaseClient, "discover">;
  private readonly now: () => number;
  private cache: ReleaseUpdateCache | null = null;
  private started = false;
  private disposed = false;
  private storageUnavailable = false;
  private inFlight: Promise<ReleaseUpdateState> | undefined;
  private controller: AbortController | undefined;
  private automaticRequest = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastManualAt = -Infinity;
  private readonly listeners = new Set<(state: ReleaseUpdateState) => void>();

  constructor(private readonly options: ReleaseUpdateServiceOptions) {
    this.now = options.now ?? Date.now;
    this.client = options.client ?? new GithubReleaseClient();
    this.store =
      options.store ??
      new ReleaseUpdateStore(options.storageDirectory, options.identity);
    this.state = {
      identity: options.identity,
      status: "idle",
      automaticChecks: options.automaticChecks,
      lastAttemptAt: null,
      checkedAt: null,
      retryAt: null,
      candidate: null,
      dismissedVersion: null,
      stale: false,
    };
  }

  snapshot(): ReleaseUpdateState {
    return this.state;
  }
  subscribe(listener: (state: ReleaseUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    await this.reload();
    if (this.disposed) return;
    this.checkDue();
    if (!this.options.identity.development) {
      this.timer = setInterval(() => this.checkDue(), DAY);
      this.timer.unref?.();
    }
  }

  checkDue(): void {
    if (
      this.disposed ||
      !this.state.automaticChecks ||
      this.options.identity.development ||
      this.storageUnavailable
    )
      return;
    void this.check(false);
  }

  check(manual = true): Promise<ReleaseUpdateState> {
    if (this.disposed) return Promise.resolve(this.state);
    if (this.inFlight) return this.inFlight;
    if (manual && this.now() - this.lastManualAt < 5_000)
      return Promise.resolve(this.state);
    if (manual) this.lastManualAt = this.now();
    this.inFlight = this.refresh(manual).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async dismiss(): Promise<ReleaseUpdateState> {
    const version = this.state.candidate?.version;
    if (!version) return this.state;
    await this.store.dismiss(version).catch(() => undefined);
    this.publish({ ...this.state, dismissedVersion: version });
    return this.state;
  }

  async setAutomaticChecks(value: boolean): Promise<void> {
    await this.options.saveAutomaticChecks?.(value);
    this.publish({ ...this.state, automaticChecks: value });
    if (!value && this.automaticRequest) this.controller?.abort();
    if (value) this.checkDue();
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
  }

  private async reload(): Promise<void> {
    const [cache, dismissedVersion] = await Promise.all([
      this.store.readCache(),
      this.store.readDismissal(),
    ]);
    if (this.disposed) return;
    this.cache = cache;
    this.publish({
      ...this.state,
      dismissedVersion,
      ...(cache ? this.projectCache(cache) : {}),
    });
  }

  private projectCache(cache: ReleaseUpdateCache): Partial<ReleaseUpdateState> {
    if (!parseReleaseVersion(this.options.identity.version))
      return { status: "unsupported", candidate: null };
    const candidate = selectReleaseUpdate(
      cache.discovery.records,
      this.options.identity,
    );
    const unverifiedNewer = cache.discovery.unverifiedVersions.some(
      (version) =>
        compareReleaseVersions(version, this.options.identity.version) > 0,
    );
    const status = candidate
      ? "available"
      : unverifiedNewer
        ? "metadata_unavailable"
        : cache.discovery.complete
          ? "current"
          : "unavailable";
    return {
      candidate,
      status,
      lastAttemptAt: cache.lastAttemptAt,
      checkedAt: cache.checkedAt,
      retryAt: cache.retryAt,
      stale:
        cache.checkedAt === null ||
        cache.lastAttemptAt > cache.checkedAt ||
        this.now() - cache.checkedAt >= DAY,
    };
  }

  private async refresh(manual: boolean): Promise<ReleaseUpdateState> {
    if (
      !parseReleaseVersion(this.options.identity.version) ||
      !expectedReleaseAsset(
        this.options.identity.product,
        this.options.identity.version,
        this.options.identity.target,
      )
    ) {
      this.publish({ ...this.state, status: "unsupported" });
      return this.state;
    }
    await this.reload();
    if (
      this.disposed ||
      (!manual &&
        (!this.state.automaticChecks || this.options.identity.development))
    )
      return this.state;
    const now = this.now();
    if (this.state.retryAt && now < this.state.retryAt) {
      this.publish({ ...this.state, status: "rate_limited" });
      return this.state;
    }
    if (
      !manual &&
      this.state.lastAttemptAt !== null &&
      now - this.state.lastAttemptAt < DAY
    )
      return this.state;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.store.acquireRefresh(now);
    } catch {
      this.storageUnavailable = true;
    }
    if (!release && !this.storageUnavailable) {
      await this.reload();
      return this.state;
    }
    if (release) {
      await this.reload();
      if (
        (this.state.retryAt !== null && this.now() < this.state.retryAt) ||
        (!manual &&
          this.state.lastAttemptAt !== null &&
          this.now() - this.state.lastAttemptAt < DAY)
      ) {
        await release();
        return this.state;
      }
    }
    if (
      this.disposed ||
      (!manual && (this.storageUnavailable || !this.state.automaticChecks))
    ) {
      await release?.();
      return this.state;
    }
    this.controller = new AbortController();
    this.automaticRequest = !manual;
    const previous: ReleaseDiscovery = this.cache?.discovery ?? {
      records: [],
      unverifiedVersions: [],
      complete: false,
    };
    const attempted: ReleaseUpdateCache = {
      schemaVersion: 1,
      lastAttemptAt: now,
      checkedAt: this.cache?.checkedAt ?? null,
      retryAt: null,
      discovery: previous,
    };
    this.cache = attempted;
    await this.persist(attempted);
    this.publish({ ...this.state, status: "checking", lastAttemptAt: now });
    try {
      const discovery = await this.client.discover(
        this.options.identity,
        this.controller.signal,
      );
      if (!this.disposed && !this.controller.signal.aborted) {
        const completed: ReleaseUpdateCache = {
          ...attempted,
          discovery,
          checkedAt: this.now(),
        };
        this.cache = completed;
        await this.persist(completed);
        this.publish({ ...this.state, ...this.projectCache(completed) });
      } else if (!this.disposed) {
        this.publish({ ...this.state, ...this.projectCache(attempted) });
      }
    } catch (error) {
      if (!this.disposed) {
        const retryAt =
          error instanceof ReleaseRateLimitError ? error.retryAt : null;
        const failed = { ...attempted, retryAt };
        this.cache = failed;
        await this.persist(failed);
        this.publish({
          ...this.state,
          ...this.projectCache(failed),
          status: retryAt ? "rate_limited" : "unavailable",
          retryAt,
          stale: true,
        });
      }
    } finally {
      this.controller = undefined;
      this.automaticRequest = false;
      await release?.();
    }
    return this.state;
  }

  private async persist(cache: ReleaseUpdateCache): Promise<void> {
    await this.store.writeCache(cache).catch(() => {
      this.storageUnavailable = true;
    });
  }
  private publish(state: ReleaseUpdateState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
