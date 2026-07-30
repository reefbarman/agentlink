import { canonicalizePath } from "../util/paths.js";
import { pathToFileURL } from "url";
import { randomUUID } from "crypto";

export const WORKSPACE_MUTATION_STATE_KEY =
  "agentLink.workspaceMutationState.v1";
export const WORKSPACE_MUTATION_STATE_VERSION = 1;

export interface WorkspaceMutationStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface WorkspaceMutationDomain {
  readonly roots: readonly string[];
  /** Optional foreground agent-tree identity. Different trees coordinate independently. */
  readonly scopeId?: string;
  /**
   * Canonical file:// prefixes this writer is enforced to stay within
   * (delegated ownedPaths). A delegated domain coexists with the unrestricted
   * tree writer that delegated it and only conflicts with overlapping
   * delegated domains or exclusive domains.
   */
  readonly delegatedPaths?: readonly string[];
  /**
   * Exclusive domains (checkpoint capture/revert) conflict with every lease in
   * scope, including path-delegated writers.
   */
  readonly exclusive?: boolean;
}

export interface CreateWorkspaceMutationDomainOptions {
  scopeId?: string;
  delegatedPaths?: readonly string[];
  exclusive?: boolean;
}

export interface WorkspaceMutationSnapshot {
  epoch: string;
  generation: number;
  ownerSessionId: string;
  scopeId?: string;
}

export interface WorkspaceMutationConflict {
  root: string;
  checkpoint: WorkspaceMutationSnapshot;
  currentEpoch: string;
  currentGeneration: number;
  conflictingSessionId?: string;
  conflictingGeneration?: number;
}

export interface WorkspaceMutationLease {
  readonly sessionId: string;
  readonly domain: WorkspaceMutationDomain;
  readonly released: boolean;
  markMutation(): Promise<ReadonlyMap<string, WorkspaceMutationSnapshot>>;
  snapshot(root: string): WorkspaceMutationSnapshot;
  release(): void;
}

interface PersistedRootMutationState {
  generation: number;
  latestGenerationBySession: Record<string, number>;
}

interface PersistedWorkspaceMutationState {
  version: typeof WORKSPACE_MUTATION_STATE_VERSION;
  epoch: string;
  roots: Record<string, PersistedRootMutationState>;
}

interface RootMutationState {
  generation: number;
  latestGenerationBySession: Map<string, number>;
}

interface PendingLeaseRequest {
  sessionId: string;
  domain: WorkspaceMutationDomain;
  resolve: (lease: WorkspaceMutationLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface WorkspaceMutationCoordinatorOptions {
  createEpoch?: () => string;
}

export class WorkspaceMutationCoordinator {
  private readonly activeLeases = new Set<WorkspaceMutationLeaseImpl>();
  private readonly pending: PendingLeaseRequest[] = [];
  private readonly rootState = new Map<string, RootMutationState>();
  private readonly createEpoch: () => string;
  private readonly epoch: string;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store?: WorkspaceMutationStateStore,
    options: WorkspaceMutationCoordinatorOptions = {},
  ) {
    this.createEpoch = options.createEpoch ?? randomUUID;
    const restored = this.restore(
      store?.get<unknown>(WORKSPACE_MUTATION_STATE_KEY),
    );
    this.epoch = restored?.epoch ?? this.createEpoch();
    if (restored) {
      for (const [root, state] of Object.entries(restored.roots)) {
        this.rootState.set(root, {
          generation: state.generation,
          latestGenerationBySession: new Map(
            Object.entries(state.latestGenerationBySession),
          ),
        });
      }
    } else if (store) {
      void this.persist();
    }
  }

  createDomain(
    roots: readonly string[],
    scopeIdOrOptions?: string | CreateWorkspaceMutationDomainOptions,
  ): WorkspaceMutationDomain {
    const options =
      typeof scopeIdOrOptions === "string"
        ? { scopeId: scopeIdOrOptions }
        : (scopeIdOrOptions ?? {});
    const canonicalRoots = [
      ...new Set(
        roots.map((root) => pathToFileURL(canonicalizePath(root)).toString()),
      ),
    ].sort();
    if (canonicalRoots.length === 0) {
      throw new Error("Workspace mutation domains require at least one root.");
    }
    const delegatedPaths = options.delegatedPaths?.length
      ? [
          ...new Set(
            options.delegatedPaths.map((path) =>
              pathToFileURL(canonicalizePath(path)).toString(),
            ),
          ),
        ].sort()
      : undefined;
    return Object.freeze({
      roots: Object.freeze(canonicalRoots),
      ...(options.scopeId ? { scopeId: options.scopeId } : {}),
      ...(delegatedPaths
        ? { delegatedPaths: Object.freeze(delegatedPaths) }
        : {}),
      ...(options.exclusive ? { exclusive: true } : {}),
    });
  }

  acquire(
    sessionId: string,
    domain: WorkspaceMutationDomain,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationLease> {
    if (signal?.aborted) {
      return Promise.reject(new Error("workspace_mutation_lease_aborted"));
    }
    return new Promise<WorkspaceMutationLease>((resolve, reject) => {
      const request: PendingLeaseRequest = {
        sessionId,
        domain,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        settled: false,
      };
      if (signal) {
        request.onAbort = () => {
          const index = this.pending.indexOf(request);
          if (index !== -1) this.pending.splice(index, 1);
          this.rejectPendingRequest(
            request,
            new Error("workspace_mutation_lease_aborted"),
          );
        };
        signal.addEventListener("abort", request.onAbort, { once: true });
      }
      this.pending.push(request);
      this.drain();
    });
  }

  getSnapshot(
    root: string,
    ownerSessionId: string,
    scopeId?: string,
  ): WorkspaceMutationSnapshot {
    const rootKey = this.toRootKey(root);
    const state = this.rootState.get(this.toStateKey(rootKey, scopeId));
    return {
      epoch: this.epoch,
      generation: state?.generation ?? 0,
      ownerSessionId,
      ...(scopeId ? { scopeId } : {}),
    };
  }

  findConflict(
    root: string,
    checkpoint: WorkspaceMutationSnapshot,
    scopeId = checkpoint.scopeId,
  ): WorkspaceMutationConflict | undefined {
    const rootKey = this.toRootKey(root);
    const state = this.rootState.get(this.toStateKey(rootKey, scopeId));
    if (checkpoint.epoch !== this.epoch || checkpoint.scopeId !== scopeId) {
      return {
        root: rootKey,
        checkpoint,
        currentEpoch: this.epoch,
        currentGeneration: state?.generation ?? 0,
      };
    }
    if (!state) return undefined;
    for (const [sessionId, generation] of state.latestGenerationBySession) {
      if (
        sessionId !== checkpoint.ownerSessionId &&
        generation > checkpoint.generation
      ) {
        return {
          root: rootKey,
          checkpoint,
          currentEpoch: this.epoch,
          currentGeneration: state.generation,
          conflictingSessionId: sessionId,
          conflictingGeneration: generation,
        };
      }
    }
    return undefined;
  }

  async whenPersisted(): Promise<void> {
    await this.saveQueue;
  }

  private drain(): void {
    for (let index = 0; index < this.pending.length;) {
      const request = this.pending[index]!;
      if (request.signal?.aborted) {
        this.pending.splice(index, 1);
        this.rejectPendingRequest(
          request,
          new Error("workspace_mutation_lease_aborted"),
        );
        continue;
      }
      if (
        this.hasActiveConflict(request.domain) ||
        this.pending
          .slice(0, index)
          .some((earlier) => domainsIntersect(earlier.domain, request.domain))
      ) {
        index++;
        continue;
      }
      this.pending.splice(index, 1);
      if (request.signal && request.onAbort) {
        request.signal.removeEventListener("abort", request.onAbort);
      }
      const lease = new WorkspaceMutationLeaseImpl(this, request);
      this.activeLeases.add(lease);
      request.settled = true;
      request.resolve(lease);
    }
  }

  private rejectPendingRequest(
    request: PendingLeaseRequest,
    error: Error,
  ): void {
    if (request.settled) return;
    request.settled = true;
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    request.reject(error);
  }

  private hasActiveConflict(domain: WorkspaceMutationDomain): boolean {
    return [...this.activeLeases].some((lease) =>
      domainsIntersect(lease.domain, domain),
    );
  }

  async markMutation(
    lease: WorkspaceMutationLeaseImpl,
  ): Promise<ReadonlyMap<string, WorkspaceMutationSnapshot>> {
    if (lease.released) throw new Error("workspace_mutation_lease_released");
    if (!this.activeLeases.has(lease)) {
      throw new Error("workspace_mutation_lease_inactive");
    }
    // Delegated writers run alongside the tree writer, so checkpoints can be
    // captured mid-lease; bumping on every mutation keeps later writes visible
    // to the revert conflict gate instead of hiding behind the first bump.
    if (lease.mutationSnapshots && !lease.domain.delegatedPaths) {
      return lease.mutationSnapshots;
    }

    const snapshots = new Map<string, WorkspaceMutationSnapshot>();
    for (const root of lease.domain.roots) {
      const stateKey = this.toStateKey(root, lease.domain.scopeId);
      const state = this.rootState.get(stateKey) ?? {
        generation: 0,
        latestGenerationBySession: new Map<string, number>(),
      };
      state.generation++;
      state.latestGenerationBySession.set(lease.sessionId, state.generation);
      this.rootState.set(stateKey, state);
      snapshots.set(root, {
        epoch: this.epoch,
        generation: state.generation,
        ownerSessionId: lease.sessionId,
        ...(lease.domain.scopeId ? { scopeId: lease.domain.scopeId } : {}),
      });
    }
    lease.mutationSnapshots = snapshots;
    await this.persist();
    return snapshots;
  }

  release(lease: WorkspaceMutationLeaseImpl): void {
    if (!this.activeLeases.delete(lease)) return;
    this.drain();
  }

  private toRootKey(root: string): string {
    return root.startsWith("file:")
      ? root
      : pathToFileURL(canonicalizePath(root)).toString();
  }

  private toStateKey(root: string, scopeId?: string): string {
    return scopeId ? `${scopeId}\u0000${root}` : root;
  }

  private persist(): Promise<void> {
    if (!this.store) return Promise.resolve();
    const operation = this.saveQueue
      .catch(() => undefined)
      .then(() =>
        this.store!.update(WORKSPACE_MUTATION_STATE_KEY, this.serialize()),
      );
    this.saveQueue = operation;
    return operation;
  }

  private serialize(): PersistedWorkspaceMutationState {
    return {
      version: WORKSPACE_MUTATION_STATE_VERSION,
      epoch: this.epoch,
      roots: Object.fromEntries(
        [...this.rootState.entries()].map(([root, state]) => [
          root,
          {
            generation: state.generation,
            latestGenerationBySession: Object.fromEntries(
              state.latestGenerationBySession,
            ),
          },
        ]),
      ),
    };
  }

  private restore(value: unknown): PersistedWorkspaceMutationState | undefined {
    if (!isRecord(value)) return undefined;
    if (value.version !== WORKSPACE_MUTATION_STATE_VERSION) return undefined;
    if (typeof value.epoch !== "string" || !isRecord(value.roots))
      return undefined;
    const roots: Record<string, PersistedRootMutationState> = {};
    for (const [root, rawState] of Object.entries(value.roots)) {
      if (!root.startsWith("file:") || !isRecord(rawState)) return undefined;
      if (
        !Number.isSafeInteger(rawState.generation) ||
        Number(rawState.generation) < 0 ||
        !isRecord(rawState.latestGenerationBySession)
      ) {
        return undefined;
      }
      const latestGenerationBySession: Record<string, number> = {};
      for (const [sessionId, generation] of Object.entries(
        rawState.latestGenerationBySession,
      )) {
        if (!Number.isSafeInteger(generation) || Number(generation) < 0) {
          return undefined;
        }
        latestGenerationBySession[sessionId] = Number(generation);
      }
      roots[root] = {
        generation: Number(rawState.generation),
        latestGenerationBySession,
      };
    }
    return {
      version: WORKSPACE_MUTATION_STATE_VERSION,
      epoch: value.epoch,
      roots,
    };
  }
}

class WorkspaceMutationLeaseImpl implements WorkspaceMutationLease {
  released = false;
  mutationSnapshots: Map<string, WorkspaceMutationSnapshot> | undefined;

  readonly sessionId: string;
  readonly domain: WorkspaceMutationDomain;

  constructor(
    private readonly coordinator: WorkspaceMutationCoordinator,
    request: PendingLeaseRequest,
  ) {
    this.sessionId = request.sessionId;
    this.domain = request.domain;
  }

  async markMutation(): Promise<
    ReadonlyMap<string, WorkspaceMutationSnapshot>
  > {
    return this.coordinator.markMutation(this);
  }

  snapshot(root: string): WorkspaceMutationSnapshot {
    return this.coordinator.getSnapshot(
      root,
      this.sessionId,
      this.domain.scopeId,
    );
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.coordinator.release(this);
  }
}

function domainsIntersect(
  left: WorkspaceMutationDomain,
  right: WorkspaceMutationDomain,
): boolean {
  if (left.scopeId !== right.scopeId) return false;
  const rightRoots = new Set(right.roots);
  if (!left.roots.some((root) => rightRoots.has(root))) return false;
  if (left.exclusive || right.exclusive) return true;
  if (left.delegatedPaths && right.delegatedPaths) {
    return left.delegatedPaths.some((leftPath) =>
      right.delegatedPaths!.some((rightPath) =>
        fileUrlPrefixesOverlap(leftPath, rightPath),
      ),
    );
  }
  // A path-delegated writer's writes are enforced to stay inside its
  // delegatedPaths, so it may run alongside the unrestricted tree writer that
  // delegated that scope to it.
  if (left.delegatedPaths || right.delegatedPaths) return false;
  return true;
}

function fileUrlPrefixesOverlap(left: string, right: string): boolean {
  const a = left.endsWith("/") ? left.slice(0, -1) : left;
  const b = right.endsWith("/") ? right.slice(0, -1) : right;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
