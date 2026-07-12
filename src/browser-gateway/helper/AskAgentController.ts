import type { ApprovalRequest } from "../../approvals/webview/types.js";
import type { BrowserGatewayThemeSnapshot } from "../../shared/types.js";
import type { BrowserGatewayAskAgentPreferencesSnapshot } from "../browserGatewayAskAgentPreferences.js";
import type {
  BrowserGatewayAskAgentHistorySnapshot,
  BrowserGatewayAskAgentMemoryCandidateNudge,
  BrowserGatewayAskAgentSnapshot,
} from "../browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayAskAgentSessionStore } from "../browserGatewayAskAgentSessionStore.js";
import type { BrowserGatewayModelCredentialStatus } from "../browserGatewayModelCredentialCache.js";
import type { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  AskAgentSnapshotPublicationQueue,
  type AskAgentSnapshotPublication,
} from "./askAgentSnapshotPublicationQueue.js";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

export type AskAgentControllerSnapshot =
  DeepReadonly<BrowserGatewayAskAgentSnapshot>;

export type AskAgentControllerPublication = DeepReadonly<
  AskAgentSnapshotPublication<AskAgentControllerSnapshot>
>;

type AskAgentStoreProjection = ReturnType<
  BrowserGatewayAskAgentSessionStore["getOrCreate"]
>;

export interface AskAgentControllerState {
  readonly ownerRegistration: AskAgentStoreProjection["ownerRegistration"];
  readonly session: AskAgentStoreProjection["session"];
  readonly snapshot: AskAgentControllerSnapshot;
}

export interface AskAgentControllerProjectionOptions {
  now: number;
  theme: BrowserGatewayThemeSnapshot;
  modelCredentialStatus: BrowserGatewayModelCredentialStatus;
  approval?: ApprovalRequest | null;
  memoryCandidateNudge?: BrowserGatewayAskAgentMemoryCandidateNudge | null;
}

export interface AskAgentControllerOptions {
  ownerRegistry: BrowserGatewayCoreOwnerRegistry;
  coalesceMs: number;
  serialize(snapshot: AskAgentControllerSnapshot): string;
  byteLength(serialized: string): number;
  publish(publication: AskAgentControllerPublication): void | Promise<void>;
  onSnapshotBuilt?(
    snapshot: AskAgentControllerSnapshot,
    durationMs: number,
  ): void;
}

export function freezeAskAgentControllerSnapshot(
  snapshot: BrowserGatewayAskAgentSnapshot,
): AskAgentControllerSnapshot {
  const cloned = structuredClone(snapshot);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(cloned);
  return cloned;
}

export class AskAgentController {
  readonly sessionStore: BrowserGatewayAskAgentSessionStore;
  private readonly snapshotQueue: AskAgentSnapshotPublicationQueue<AskAgentControllerSnapshot>;

  constructor(private readonly options: AskAgentControllerOptions) {
    this.sessionStore = new BrowserGatewayAskAgentSessionStore(
      options.ownerRegistry,
    );
    this.snapshotQueue = new AskAgentSnapshotPublicationQueue({
      coalesceMs: options.coalesceMs,
      serialize: options.serialize,
      byteLength: options.byteLength,
      publish: options.publish,
    });
  }

  restoreState(
    preferences: BrowserGatewayAskAgentPreferencesSnapshot,
    history: BrowserGatewayAskAgentHistorySnapshot,
  ): void {
    this.sessionStore.applyPreferences(preferences);
    this.sessionStore.loadHistory(history);
  }

  projectState(
    options: AskAgentControllerProjectionOptions,
  ): AskAgentControllerState {
    const startedAt = performance.now();
    const response = this.sessionStore.getOrCreate({
      now: options.now,
      theme: options.theme,
      modelCredentialStatus: options.modelCredentialStatus,
      approval: options.approval ?? null,
      memoryCandidateNudge: options.memoryCandidateNudge ?? null,
    });
    const snapshot = freezeAskAgentControllerSnapshot(response.snapshot);
    this.options.onSnapshotBuilt?.(snapshot, performance.now() - startedAt);
    return {
      ownerRegistration: response.ownerRegistration,
      session: response.session,
      snapshot,
    };
  }

  publishableSnapshot(
    snapshot: BrowserGatewayAskAgentSnapshot | AskAgentControllerSnapshot,
  ): AskAgentControllerSnapshot {
    return freezeAskAgentControllerSnapshot(
      snapshot as BrowserGatewayAskAgentSnapshot,
    );
  }

  publishSnapshot(
    snapshot: BrowserGatewayAskAgentSnapshot | AskAgentControllerSnapshot,
  ): Promise<AskAgentControllerPublication> {
    const committedSnapshot = this.publishableSnapshot(snapshot);
    return this.snapshotQueue.publishNow(() => committedSnapshot);
  }

  publishProjectedSnapshot(
    build: () => AskAgentControllerSnapshot,
  ): Promise<AskAgentControllerPublication> {
    return this.snapshotQueue.publishNow(build);
  }

  scheduleProjectedSnapshot(
    build: () => AskAgentControllerSnapshot,
  ): Promise<AskAgentControllerPublication> {
    return this.snapshotQueue.schedule(build);
  }

  async dispose(): Promise<void> {
    await this.snapshotQueue.dispose();
  }
}
