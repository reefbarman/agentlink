import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import type { BrowserGatewayAskAgentPreferencesSnapshot } from "../browserGatewayAskAgentPreferences.js";
import type {
  BrowserGatewayAskAgentHistorySnapshot,
  BrowserGatewayAskAgentMemoryCandidateNudge,
  BrowserGatewayAskAgentSnapshot,
} from "../browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayAskAgentSessionStore } from "../browserGatewayAskAgentSessionStore.js";
import type { BrowserGatewayModelCredentialStatus } from "../browserGatewayModelCredentialCache.js";
import type { CoreCapabilityStatusDto } from "@agentlink/protocol/session";
import type { MemoryCandidateKind } from "../../shared/memoryCandidates.js";
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

export interface AskAgentControllerTurn {
  readonly messageId: string;
  readonly signal: AbortSignal;
}

interface ActiveAskAgentControllerTurn extends AskAgentControllerTurn {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  stopped: boolean;
  /** Whether the turn already received a missing-response completion nudge. */
  finalStatusNudged: boolean;
  settle(): void;
}

interface PendingAskAgentControllerApproval {
  readonly request: ApprovalRequest;
  resolve(decision: DecisionMessage): void;
  reject(error: Error): void;
}

export type AskAgentControllerTurnOutcome =
  | "model_success"
  | "model_empty"
  | "model_question"
  | "model_final"
  | "model_stopped"
  | "model_auth_failed"
  | "model_error"
  | "credential_missing"
  | "duplicate_ignored";

export interface AskAgentControllerOptions {
  ownerRegistry: BrowserGatewayCoreOwnerRegistry;
  ownerGenerationId?: string;
  additionalOwnerCapabilities?: readonly CoreCapabilityStatusDto[];
  coalesceMs: number;
  serialize(snapshot: AskAgentControllerSnapshot): string;
  byteLength(serialized: string): number;
  publish(publication: AskAgentControllerPublication): void | Promise<void>;
  onSnapshotBuilt?(
    snapshot: AskAgentControllerSnapshot,
    durationMs: number,
  ): void;
  memoryNudgeLimit?: number;
  createMemoryNudgeId?(): string;
  onMemoryNudgeDetected?(
    nudge: BrowserGatewayAskAgentMemoryCandidateNudge,
  ): void;
  onCompletedTurn?(sessionId: string): void;
  onActiveTurnChanged?(active: boolean): void;
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
  private activeTurn: ActiveAskAgentControllerTurn | null = null;
  private cancellation: {
    turn: ActiveAskAgentControllerTurn;
    promise: Promise<AskAgentControllerPublication | null>;
  } | null = null;
  private readonly pendingCancellations = new Set<
    Promise<AskAgentControllerPublication | null>
  >();
  private pendingApproval: PendingAskAgentControllerApproval | null = null;
  private memoryCandidateNudge: BrowserGatewayAskAgentMemoryCandidateNudge | null =
    null;
  private readonly memoryCandidateNudgeCounts = new Map<string, number>();
  private readonly memoryCandidateDismissed = new Set<string>();

  constructor(private readonly options: AskAgentControllerOptions) {
    this.sessionStore = new BrowserGatewayAskAgentSessionStore(
      options.ownerRegistry,
      {},
      {
        ownerGenerationId: options.ownerGenerationId,
        additionalCapabilities: options.additionalOwnerCapabilities,
      },
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

  recordTurnOutcome(sessionId: string, outcome: string): void {
    if (
      outcome === "model_success" ||
      outcome === "model_empty" ||
      outcome === "model_question" ||
      outcome === "model_final"
    ) {
      this.options.onCompletedTurn?.(sessionId);
    }
  }

  getMemoryCandidateNudge(): BrowserGatewayAskAgentMemoryCandidateNudge | null {
    return this.memoryCandidateNudge;
  }

  considerMemoryCandidate(params: {
    sessionId: string;
    now: number;
    candidate: { kind: MemoryCandidateKind; matchedPhrase: string } | null;
    approvalPending: boolean;
  }): BrowserGatewayAskAgentMemoryCandidateNudge | null {
    if (params.approvalPending || !params.candidate) return null;
    if (this.memoryCandidateNudge?.sessionId === params.sessionId) return null;
    const nudgeCount =
      this.memoryCandidateNudgeCounts.get(params.sessionId) ?? 0;
    if (nudgeCount >= (this.options.memoryNudgeLimit ?? 0)) return null;
    const key = this.memoryCandidateNudgeKey({
      sessionId: params.sessionId,
      kind: params.candidate.kind,
      matchedPhrase: params.candidate.matchedPhrase,
    });
    if (this.memoryCandidateDismissed.has(key)) return null;
    const nudge: BrowserGatewayAskAgentMemoryCandidateNudge = {
      id:
        this.options.createMemoryNudgeId?.() ??
        `ask-agent-memory-nudge-${params.now}`,
      sessionId: params.sessionId,
      createdAt: params.now,
      kind: params.candidate.kind,
      matchedPhrase: params.candidate.matchedPhrase,
      suggestedScope: "global",
      suggestedTier: "memory",
      title: "Remember from Ask Agent",
      rationale:
        "Ask Agent detected a possible durable user preference for low-authority memory.",
      content: params.candidate.matchedPhrase,
    };
    this.memoryCandidateNudgeCounts.set(params.sessionId, nudgeCount + 1);
    this.memoryCandidateNudge = nudge;
    this.options.onMemoryNudgeDetected?.(nudge);
    return nudge;
  }

  dismissMemoryCandidateNudge(id: string): void {
    const nudge = this.memoryCandidateNudge;
    if (!nudge || nudge.id !== id) return;
    this.memoryCandidateDismissed.add(this.memoryCandidateNudgeKey(nudge));
    this.memoryCandidateNudge = null;
  }

  clearMemoryCandidateNudgeForSession(sessionId: string): void {
    if (this.memoryCandidateNudge?.sessionId === sessionId) {
      this.memoryCandidateNudge = null;
    }
    this.memoryCandidateNudgeCounts.delete(sessionId);
    const prefix = `${sessionId.trim().toLowerCase()}::`;
    for (const key of this.memoryCandidateDismissed) {
      if (key.startsWith(prefix)) this.memoryCandidateDismissed.delete(key);
    }
  }

  private memoryCandidateNudgeKey(params: {
    sessionId: string;
    kind: string;
    matchedPhrase: string;
  }): string {
    return [params.sessionId, params.kind, params.matchedPhrase]
      .map((part) => part.trim().toLowerCase().replace(/\s+/g, " "))
      .join("::");
  }

  getPendingApproval(): ApprovalRequest | null {
    return this.pendingApproval?.request ?? null;
  }

  requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<DecisionMessage> {
    if (this.pendingApproval) {
      return Promise.reject(new Error("ask_agent_approval_pending"));
    }
    if (signal.aborted) {
      return Promise.reject(new Error("ask_agent_approval_cancelled"));
    }
    return new Promise<DecisionMessage>((resolve, reject) => {
      const rejectApproval = (error: Error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => {
        if (this.pendingApproval?.request.id === request.id) {
          this.pendingApproval = null;
        }
        rejectApproval(new Error("ask_agent_approval_cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingApproval = {
        request,
        resolve: (decision) => {
          signal.removeEventListener("abort", abort);
          resolve(decision);
        },
        reject: rejectApproval,
      };
    });
  }

  submitApproval(decision: DecisionMessage): ApprovalRequest | null {
    const pending = this.pendingApproval;
    if (!pending || pending.request.id !== decision.id) return null;
    this.pendingApproval = null;
    pending.resolve(decision);
    return pending.request;
  }

  appendAssistantDelta(
    ...args: Parameters<
      BrowserGatewayAskAgentSessionStore["appendAssistantDelta"]
    >
  ): void {
    this.sessionStore.appendAssistantDelta(...args);
  }

  startAssistantToolCall(
    ...args: Parameters<
      BrowserGatewayAskAgentSessionStore["startAssistantToolCall"]
    >
  ): void {
    this.sessionStore.startAssistantToolCall(...args);
  }

  completeAssistantToolCall(
    ...args: Parameters<
      BrowserGatewayAskAgentSessionStore["completeAssistantToolCall"]
    >
  ): void {
    this.sessionStore.completeAssistantToolCall(...args);
  }

  setTodos(
    ...args: Parameters<BrowserGatewayAskAgentSessionStore["setTodos"]>
  ): void {
    this.sessionStore.setTodos(...args);
  }

  setQuestionRequest(
    ...args: Parameters<
      BrowserGatewayAskAgentSessionStore["setQuestionRequest"]
    >
  ): void {
    this.sessionStore.setQuestionRequest(...args);
  }

  completeTodos(): ReturnType<
    BrowserGatewayAskAgentSessionStore["completeTodos"]
  > {
    return this.sessionStore.completeTodos();
  }

  applyFinalMarker(
    ...args: Parameters<BrowserGatewayAskAgentSessionStore["applyFinalMarker"]>
  ): void {
    this.sessionStore.applyFinalMarker(...args);
  }

  finishAssistantError(
    ...args: Parameters<
      BrowserGatewayAskAgentSessionStore["finishAssistantErrorMessage"]
    >
  ): void {
    this.sessionStore.finishAssistantErrorMessage(...args);
  }

  finishAssistantSuccess(params: {
    messageId: string;
    text: string;
    memoryDisclosure?: ChatMessage["memoryDisclosure"];
  }): void {
    this.sessionStore.finishAssistantMessage(
      params.messageId,
      params.text,
      params.memoryDisclosure,
    );
  }

  finishAssistantEmpty(params: {
    messageId: string;
    text: string;
    code: string;
  }): void {
    this.finishAssistantError({
      messageId: params.messageId,
      text: params.text,
      code: params.code,
      retryable: true,
    });
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  beginTurn(messageId: string): AskAgentControllerTurn | null {
    if (this.activeTurn) return null;
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let didSettle = false;
    this.activeTurn = {
      messageId,
      signal: controller.signal,
      controller,
      stopped: false,
      finalStatusNudged: false,
      settled,
      settle: () => {
        if (didSettle) return;
        didSettle = true;
        resolveSettled();
      },
    };
    this.notifyActiveTurnChanged(true);
    return this.activeTurn;
  }

  getActiveTurnMessageId(): string | null {
    return this.activeTurn?.messageId ?? null;
  }

  /**
   * Record that the active turn was nudged to actually deliver a response
   * before completing. Returns true only for the first nudge of a turn, so a
   * model that insists on completing without content cannot loop forever.
   */
  noteFinalStatusNudge(): boolean {
    if (!this.activeTurn || this.activeTurn.finalStatusNudged) return false;
    this.activeTurn.finalStatusNudged = true;
    return true;
  }

  isTurnStopped(turn: AskAgentControllerTurn): boolean {
    return this.activeTurn === turn && this.activeTurn.stopped;
  }

  completeTurn(turn: AskAgentControllerTurn): void {
    if (this.activeTurn !== turn) return;
    this.activeTurn.settle();
    this.activeTurn = null;
    this.notifyActiveTurnChanged(false);
  }

  cancelActiveTurn(
    finalize: (messageId: string) => Promise<AskAgentControllerPublication>,
  ): Promise<AskAgentControllerPublication | null> {
    const activeTurn = this.activeTurn;
    if (!activeTurn) return Promise.resolve(null);
    if (this.cancellation?.turn === activeTurn) {
      return this.cancellation.promise;
    }
    activeTurn.stopped = true;
    activeTurn.controller.abort();
    const cancellation = {
      turn: activeTurn,
      promise: Promise.resolve<AskAgentControllerPublication | null>(null),
    };
    cancellation.promise = finalize(activeTurn.messageId).finally(() => {
      this.pendingCancellations.delete(cancellation.promise);
      if (this.cancellation === cancellation) this.cancellation = null;
    });
    this.cancellation = cancellation;
    this.pendingCancellations.add(cancellation.promise);
    return cancellation.promise;
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
    const pendingApproval = this.pendingApproval;
    this.pendingApproval = null;
    pendingApproval?.reject(new Error("ask_agent_approval_cancelled"));
    const activeTurn = this.activeTurn;
    if (activeTurn) {
      activeTurn.stopped = true;
      activeTurn.controller.abort();
      await activeTurn.settled;
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
        this.notifyActiveTurnChanged(false);
      }
    }
    await Promise.all(this.pendingCancellations);
    await this.snapshotQueue.dispose();
  }

  private notifyActiveTurnChanged(active: boolean): void {
    try {
      this.options.onActiveTurnChanged?.(active);
    } catch {
      // Liveness observers must not affect turn ownership.
    }
  }
}
