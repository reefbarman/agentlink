import type {
  AgentModelReference,
  AgentTurnEvent,
  AgentTurnResult,
  CoreReasoningEffort,
} from "@agentlink/core";
import type {
  BackgroundAgentRuntimePhase,
  BackgroundResultState,
} from "@agentlink/protocol";

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STATE_VERSION = 1;
const STATE_FILE = "background-agents.json";
const DEFAULT_MAX_ACTIVE_CHILDREN = 2;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TASK_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_STEERING_MESSAGES = 8;

export type WorkspaceBackgroundLifecycle =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WorkspaceBackgroundPathScope {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly access: "read" | "read_write";
}

export interface WorkspaceBackgroundApproval {
  readonly interactionId: string;
  readonly source: "durable_interaction" | "host_operation";
  readonly toolName: string;
  readonly summary: string;
  readonly operationDigest?: string;
  readonly displayContent?: unknown;
  readonly createdAt: number;
}

export interface WorkspaceBackgroundRecord {
  readonly schemaVersion: 1;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly rootSessionId: string;
  readonly projectId: string;
  readonly depth: 1;
  readonly task: string;
  readonly scopes: readonly WorkspaceBackgroundPathScope[];
  readonly model?: AgentModelReference;
  readonly reasoningEffort?: CoreReasoningEffort;
  readonly lifecycle: WorkspaceBackgroundLifecycle;
  readonly phase: BackgroundAgentRuntimePhase;
  readonly resultState: BackgroundResultState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly currentTool?: string;
  readonly resultText?: string;
  readonly partialOutput?: string;
  readonly terminalReason?: string;
  readonly approval?: WorkspaceBackgroundApproval;
  readonly steeringQueued: number;
}

export interface SpawnWorkspaceBackgroundRequest {
  readonly callerSessionId: string;
  readonly callerTurnId: string;
  readonly task: string;
  readonly message: string;
  readonly readScopes: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
  }[];
  readonly writeScopes: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
  }[];
  readonly model?: AgentModelReference;
  readonly reasoningEffort?: CoreReasoningEffort;
}

export interface WorkspaceBackgroundTargetRequest {
  readonly callerSessionId: string;
  readonly childSessionId: string;
}

export interface WorkspaceBackgroundWaitRequest extends WorkspaceBackgroundTargetRequest {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type WorkspaceBackgroundWaitResult =
  | { readonly status: "completed"; readonly record: WorkspaceBackgroundRecord }
  | {
      readonly status: "still_running";
      readonly record: WorkspaceBackgroundRecord;
    }
  | {
      readonly status: "wait_interrupted";
      readonly record: WorkspaceBackgroundRecord;
    };

export type WorkspaceBackgroundResult =
  | { readonly status: "completed"; readonly record: WorkspaceBackgroundRecord }
  | {
      readonly status: "not_ready";
      readonly record: WorkspaceBackgroundRecord;
    };

export async function readWorkspaceBackgroundSessionIds(
  stateDirectory: string,
): Promise<ReadonlySet<string>> {
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("background_state_directory_must_be_absolute");
  }
  const statePath = path.join(stateDirectory, STATE_FILE);
  const raw = await fs.readFile(statePath, "utf8").catch((error) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!raw) return new Set();
  const state = JSON.parse(raw) as DurableState;
  if (
    state.version !== STATE_VERSION ||
    !Array.isArray(state.records) ||
    !state.records.every(validRecord)
  ) {
    throw new Error("background_state_invalid");
  }
  return new Set(state.records.map((record) => record.childSessionId));
}

export interface CreateWorkspaceBackgroundSupervisorOptions {
  readonly stateDirectory: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly maxActiveChildren?: number;
  readonly maxOutputBytes?: number;
  readonly now?: () => number;
  readonly createChildSession: (request: {
    readonly parentSessionId: string;
    readonly model?: AgentModelReference;
    readonly reasoningEffort?: CoreReasoningEffort;
  }) => Promise<{
    readonly sessionId: string;
    readonly model?: AgentModelReference;
    readonly reasoningEffort?: CoreReasoningEffort;
  }>;
  readonly validateScopes?: (request: {
    readonly parentSessionId: string;
    readonly parentTurnId: string;
    readonly scopes: readonly WorkspaceBackgroundPathScope[];
  }) => boolean | Promise<boolean>;
  readonly onApprovalAvailable?: (request: {
    readonly parentSessionId: string;
    readonly childSessionId: string;
  }) => void;
  readonly runTurn: (
    childSessionId: string,
    message: string,
    options: {
      readonly signal: AbortSignal;
      readonly onEvent: (event: AgentTurnEvent) => void;
    },
  ) => Promise<AgentTurnResult>;
  readonly resumeInteraction: (
    childSessionId: string,
    decision: "allow" | "deny",
    options: {
      readonly signal: AbortSignal;
      readonly onEvent: (event: AgentTurnEvent) => void;
    },
  ) => Promise<AgentTurnResult>;
  readonly cancelSession: (
    childSessionId: string,
    reason: string,
  ) => Promise<void>;
}

interface LiveBackgroundChild {
  readonly controller: AbortController;
  running?: Promise<void>;
  streamedOutput: boolean;
}

interface PendingHostApproval {
  readonly interactionId: string;
  readonly resolve: (allowed: boolean) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

interface DurableState {
  readonly version: 1;
  readonly records: readonly WorkspaceBackgroundRecord[];
  readonly steering: Readonly<Record<string, readonly string[]>>;
}

/**
 * Host-native, one-level background writer supervision. It owns durable child
 * identity, scoped path reservations, bounded output, waits, steering, and stop.
 * Model execution and human approval remain injected host responsibilities.
 */
export class WorkspaceBackgroundSupervisor {
  private readonly records = new Map<string, WorkspaceBackgroundRecord>();
  private readonly live = new Map<string, LiveBackgroundChild>();
  private readonly steering = new Map<string, string[]>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly hostApprovals = new Map<string, PendingHostApproval>();
  private readonly statePath: string;
  private readonly projectRoot: string;
  private readonly maxActiveChildren: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private persistTail: Promise<void> = Promise.resolve();
  private admissionTail: Promise<void> = Promise.resolve();
  private persistTimer: NodeJS.Timeout | undefined;
  private persistError: Error | undefined;
  private closed = false;

  private constructor(
    private readonly options: CreateWorkspaceBackgroundSupervisorOptions,
  ) {
    this.statePath = path.join(options.stateDirectory, STATE_FILE);
    this.projectRoot = path.resolve(options.projectRoot);
    this.maxActiveChildren =
      options.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_CHILDREN;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.now = options.now ?? Date.now;
  }

  static async create(
    options: CreateWorkspaceBackgroundSupervisorOptions,
  ): Promise<WorkspaceBackgroundSupervisor> {
    if (!path.isAbsolute(options.stateDirectory)) {
      throw new Error("background_state_directory_must_be_absolute");
    }
    if (!path.isAbsolute(options.projectRoot)) {
      throw new Error("background_project_root_must_be_absolute");
    }
    if (!options.projectId.trim())
      throw new Error("background_project_id_required");
    const supervisor = new WorkspaceBackgroundSupervisor(options);
    await supervisor.open();
    return supervisor;
  }

  list(callerSessionId: string): readonly WorkspaceBackgroundRecord[] {
    this.assertForegroundCaller(callerSessionId);
    return [...this.records.values()]
      .filter((record) => record.parentSessionId === callerSessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(cloneRecord);
  }

  listPendingApprovals(
    callerSessionId: string,
  ): readonly WorkspaceBackgroundRecord[] {
    return this.list(callerSessionId)
      .filter((record) => record.lifecycle === "awaiting_approval")
      .sort(
        (left, right) =>
          (left.approval?.createdAt ?? left.updatedAt) -
          (right.approval?.createdAt ?? right.updatedAt),
      );
  }

  getRecordForSession(
    sessionId: string,
  ): WorkspaceBackgroundRecord | undefined {
    const record = this.records.get(sessionId);
    return record ? cloneRecord(record) : undefined;
  }

  async spawn(
    request: SpawnWorkspaceBackgroundRequest,
  ): Promise<WorkspaceBackgroundRecord> {
    const releaseAdmission = await this.acquireAdmission();
    try {
      if (this.closed) throw new Error("background_supervisor_closed");
      this.assertForegroundCaller(request.callerSessionId);
      if (this.activeCount() >= this.maxActiveChildren) {
        throw new Error("background_child_capacity_reached");
      }
      const task = boundedRequiredText(request.task, MAX_TASK_BYTES, "task");
      const message = boundedRequiredText(
        request.message,
        MAX_MESSAGE_BYTES,
        "message",
      );
      if (request.writeScopes.length === 0) {
        throw new Error("background_write_scope_required");
      }
      const scopes = await this.resolveScopes(
        request.readScopes,
        request.writeScopes,
      );
      if (
        this.options.validateScopes &&
        !(await this.options.validateScopes({
          parentSessionId: request.callerSessionId,
          parentTurnId: request.callerTurnId,
          scopes,
        }))
      ) {
        throw new Error("background_scope_exceeds_parent_authority");
      }
      this.assertDisjointWriteReservations(scopes);
      const child = await this.options.createChildSession({
        parentSessionId: request.callerSessionId,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
      });
      const timestamp = this.now();
      const record: WorkspaceBackgroundRecord = {
        schemaVersion: 1,
        childSessionId: child.sessionId,
        parentSessionId: request.callerSessionId,
        parentTurnId: request.callerTurnId,
        rootSessionId: request.callerSessionId,
        projectId: this.options.projectId,
        depth: 1,
        task,
        scopes,
        ...(child.model ? { model: structuredClone(child.model) } : {}),
        ...(child.reasoningEffort
          ? { reasoningEffort: child.reasoningEffort }
          : {}),
        lifecycle: "queued",
        phase: "queued",
        resultState: "running",
        createdAt: timestamp,
        updatedAt: timestamp,
        steeringQueued: 0,
      };
      this.records.set(record.childSessionId, record);
      this.steering.set(record.childSessionId, []);
      await this.persist();
      this.startRun(record.childSessionId, message, false);
      return cloneRecord(
        this.requireOwned({
          callerSessionId: request.callerSessionId,
          childSessionId: record.childSessionId,
        }),
      );
    } finally {
      releaseAdmission();
    }
  }

  status(request: WorkspaceBackgroundTargetRequest): WorkspaceBackgroundRecord {
    return cloneRecord(this.requireOwned(request));
  }

  async wait(
    request: WorkspaceBackgroundWaitRequest,
  ): Promise<WorkspaceBackgroundWaitResult> {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("background_wait_timeout_invalid");
    }
    const initial = this.requireOwned(request);
    if (isTerminal(initial)) {
      return { status: "completed", record: cloneRecord(initial) };
    }
    if (request.signal?.aborted) {
      return { status: "wait_interrupted", record: cloneRecord(initial) };
    }
    const outcome = await new Promise<"changed" | "timeout" | "interrupted">(
      (resolve) => {
        let settled = false;
        const finish = (value: "changed" | "timeout" | "interrupted") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          const waiters = this.waiters.get(request.childSessionId);
          waiters?.delete(onChanged);
          if (waiters?.size === 0) this.waiters.delete(request.childSessionId);
          resolve(value);
        };
        const onChanged = () => finish("changed");
        const onAbort = () => finish("interrupted");
        const timer = setTimeout(() => finish("timeout"), request.timeoutMs);
        timer.unref?.();
        const waiters = this.waiters.get(request.childSessionId) ?? new Set();
        waiters.add(onChanged);
        this.waiters.set(request.childSessionId, waiters);
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (isTerminal(this.requireOwned(request))) finish("changed");
      },
    );
    const record = cloneRecord(this.requireOwned(request));
    if (isTerminal(record)) return { status: "completed", record };
    return {
      status: outcome === "interrupted" ? "wait_interrupted" : "still_running",
      record,
    };
  }

  result(request: WorkspaceBackgroundTargetRequest): WorkspaceBackgroundResult {
    const record = cloneRecord(this.requireOwned(request));
    return isTerminal(record)
      ? { status: "completed", record }
      : { status: "not_ready", record };
  }

  async steer(
    request: WorkspaceBackgroundTargetRequest & { readonly message: string },
  ): Promise<{ readonly status: "queued" | "already_pending" }> {
    const record = this.requireOwned(request);
    if (isTerminal(record)) throw new Error("background_child_not_running");
    const message = boundedRequiredText(
      request.message,
      MAX_MESSAGE_BYTES,
      "steering message",
    );
    const pending = this.steering.get(record.childSessionId) ?? [];
    if (pending.length >= MAX_STEERING_MESSAGES) {
      throw new Error("background_steering_queue_full");
    }
    pending.push(message);
    this.steering.set(record.childSessionId, pending);
    this.update(record.childSessionId, { steeringQueued: pending.length });
    await this.persist();
    return { status: "queued" };
  }

  async requestForegroundApproval(request: {
    readonly childSessionId: string;
    readonly toolName: string;
    readonly summary: string;
    readonly operationDigest?: string;
    readonly displayContent?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    const record = this.requireRecord(request.childSessionId);
    if (isTerminal(record)) throw new Error("background_child_not_running");
    if (record.approval || this.hostApprovals.has(record.childSessionId)) {
      throw new Error("background_approval_already_pending");
    }
    if (request.signal?.aborted) return false;
    const interactionId = `host-${randomUUID()}`;
    const decision = new Promise<boolean>((resolve) => {
      const pending: PendingHostApproval = {
        interactionId,
        resolve,
        ...(request.signal ? { signal: request.signal } : {}),
      };
      if (request.signal) {
        pending.onAbort = () =>
          this.settleHostApproval(record.childSessionId, false);
        request.signal.addEventListener("abort", pending.onAbort, {
          once: true,
        });
      }
      this.hostApprovals.set(record.childSessionId, pending);
    });
    this.update(record.childSessionId, {
      lifecycle: "awaiting_approval",
      phase: "awaiting_approval",
      approval: {
        interactionId,
        source: "host_operation",
        toolName: boundedRequiredText(request.toolName, 1_024, "tool name"),
        summary: boundedRequiredText(
          request.summary,
          8_192,
          "approval summary",
        ),
        ...(request.operationDigest
          ? { operationDigest: request.operationDigest }
          : {}),
        ...(request.displayContent === undefined
          ? {}
          : { displayContent: structuredClone(request.displayContent) }),
        createdAt: this.now(),
      },
    });
    await this.persist();
    this.options.onApprovalAvailable?.({
      parentSessionId: record.parentSessionId,
      childSessionId: record.childSessionId,
    });
    return await decision;
  }

  async respondToApproval(
    request: WorkspaceBackgroundTargetRequest & {
      readonly interactionId: string;
      readonly decision: "allow" | "deny";
    },
  ): Promise<WorkspaceBackgroundRecord> {
    const record = this.requireOwned(request);
    if (
      record.lifecycle !== "awaiting_approval" ||
      record.approval?.interactionId !== request.interactionId
    ) {
      throw new Error("background_approval_not_current");
    }
    if (record.approval.source === "host_operation") {
      const pending = this.hostApprovals.get(record.childSessionId);
      if (pending?.interactionId !== request.interactionId) {
        throw new Error("background_approval_not_current");
      }
      this.update(record.childSessionId, {
        lifecycle: "running",
        phase: "waiting_for_provider",
        approval: undefined,
      });
      await this.persist();
      this.settleHostApproval(
        record.childSessionId,
        request.decision === "allow",
      );
      return cloneRecord(this.requireOwned(request));
    }
    this.update(record.childSessionId, {
      lifecycle: "running",
      phase: "waiting_for_provider",
      approval: undefined,
    });
    await this.persist();
    this.startRun(record.childSessionId, request.decision, true);
    return cloneRecord(this.requireOwned(request));
  }

  async stop(
    request: WorkspaceBackgroundTargetRequest & { readonly reason?: string },
  ): Promise<WorkspaceBackgroundRecord> {
    const record = this.requireOwned(request);
    if (isTerminal(record)) return cloneRecord(record);
    const reason = request.reason?.trim() || "cancelled_by_foreground";
    this.settleHostApproval(record.childSessionId, false);
    this.live.get(record.childSessionId)?.controller.abort(reason);
    await this.options
      .cancelSession(record.childSessionId, reason)
      .catch(() => undefined);
    await this.finish(record.childSessionId, {
      lifecycle: "cancelled",
      phase: "cancelled",
      resultState: "cancelled",
      terminalReason: reason,
    });
    return cloneRecord(this.requireOwned(request));
  }

  assertWriteAllowed(sessionId: string, relativePath: string): boolean {
    const child = this.records.get(sessionId);
    if (child) {
      if (!isActive(child)) return false;
      return child.scopes.some(
        (scope) =>
          scope.access === "read_write" && scopeContains(scope, relativePath),
      );
    }
    for (const record of this.records.values()) {
      if (!isActive(record)) continue;
      if (
        record.scopes.some(
          (scope) =>
            scope.access === "read_write" && scopeContains(scope, relativePath),
        )
      ) {
        return false;
      }
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.records.values()].filter(isActive);
    await Promise.all(
      active.map((record) =>
        this.stop({
          callerSessionId: record.parentSessionId,
          childSessionId: record.childSessionId,
          reason: "foreground_session_closed",
        }),
      ),
    );
    await Promise.allSettled(
      [...this.live.values()].flatMap((entry) =>
        entry.running ? [entry.running] : [],
      ),
    );
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist();
  }

  private startRun(
    childSessionId: string,
    input: string | "allow" | "deny",
    resume: boolean,
  ): void {
    const existing = this.live.get(childSessionId);
    const live = existing ?? {
      controller: new AbortController(),
      streamedOutput: false,
    };
    this.live.set(childSessionId, live);
    const running = this.executeRun(
      childSessionId,
      input,
      resume,
      live.controller,
    )
      .catch(async (error: unknown) => {
        if (!isTerminal(this.records.get(childSessionId))) {
          await this.finish(childSessionId, {
            lifecycle: "failed",
            phase: "failed",
            resultState: "failed",
            terminalReason: errorMessage(error),
          });
        }
      })
      .finally(() => {
        if (live.running === running) live.running = undefined;
        if (isTerminal(this.records.get(childSessionId))) {
          this.live.delete(childSessionId);
        }
      });
    live.running = running;
  }

  private async executeRun(
    childSessionId: string,
    input: string | "allow" | "deny",
    resume: boolean,
    controller: AbortController,
  ): Promise<void> {
    const record = this.requireRecord(childSessionId);
    const live = this.live.get(childSessionId);
    if (live) live.streamedOutput = false;
    this.update(childSessionId, {
      lifecycle: "running",
      phase: "waiting_for_provider",
      startedAt: record.startedAt ?? this.now(),
    });
    await this.persist();
    const onEvent = (event: AgentTurnEvent) =>
      this.captureEvent(childSessionId, event);
    const result = resume
      ? await this.options.resumeInteraction(
          childSessionId,
          input as "allow" | "deny",
          {
            signal: controller.signal,
            onEvent,
          },
        )
      : await this.options.runTurn(childSessionId, input, {
          signal: controller.signal,
          onEvent,
        });
    await this.handleResult(childSessionId, result, controller);
  }

  private async handleResult(
    childSessionId: string,
    result: AgentTurnResult,
    controller: AbortController,
  ): Promise<void> {
    if (isTerminal(this.records.get(childSessionId))) return;
    if (result.status === "suspended") {
      this.update(childSessionId, {
        lifecycle: "awaiting_approval",
        phase: "awaiting_approval",
        approval: {
          interactionId: result.interaction.interactionId,
          source: "durable_interaction",
          toolName: result.interaction.toolName,
          summary: result.interaction.summary,
          displayContent: structuredClone(result.interaction.displayContent),
          createdAt: this.now(),
        },
      });
      await this.persist();
      const pending = this.requireRecord(childSessionId);
      this.options.onApprovalAvailable?.({
        parentSessionId: pending.parentSessionId,
        childSessionId,
      });
      return;
    }
    if (result.status === "failed") {
      await this.finish(childSessionId, {
        lifecycle: "failed",
        phase: "failed",
        resultState: "failed",
        terminalReason: result.error.message,
      });
      return;
    }
    if (result.status === "cancelled") {
      await this.finish(childSessionId, {
        lifecycle: "cancelled",
        phase: "cancelled",
        resultState: "cancelled",
        terminalReason: result.reason ?? "cancelled",
      });
      return;
    }
    if (!this.live.get(childSessionId)?.streamedOutput) {
      this.appendOutput(childSessionId, result.text);
    }
    const queued = this.steering.get(childSessionId) ?? [];
    const next = queued.shift();
    this.steering.set(childSessionId, queued);
    if (next && !controller.signal.aborted) {
      this.update(childSessionId, { steeringQueued: queued.length });
      await this.persist();
      await this.executeRun(childSessionId, next, false, controller);
      return;
    }
    await this.finish(childSessionId, {
      lifecycle: "completed",
      phase: "completed",
      resultState: "completed",
      resultText: result.text,
    });
  }

  private captureEvent(childSessionId: string, event: AgentTurnEvent): void {
    if (event.type === "text.delta") {
      const live = this.live.get(childSessionId);
      if (live) live.streamedOutput = true;
      this.appendOutput(childSessionId, event.text);
      this.update(childSessionId, { phase: "responding" });
    } else if (event.type === "tool.started") {
      this.update(childSessionId, {
        phase: "executing_tool",
        currentTool: event.toolName,
      });
    } else if (event.type === "model.resolved") {
      this.update(childSessionId, { phase: "waiting_for_provider" });
    }
  }

  private appendOutput(childSessionId: string, text: string): void {
    const record = this.requireRecord(childSessionId);
    const combined = `${record.partialOutput ?? ""}${text}`;
    this.update(childSessionId, {
      partialOutput: boundedUtf8Tail(combined, this.maxOutputBytes),
    });
    this.schedulePersist();
  }

  private async finish(
    childSessionId: string,
    values: Pick<
      WorkspaceBackgroundRecord,
      "lifecycle" | "phase" | "resultState"
    > & {
      readonly terminalReason?: string;
      readonly resultText?: string;
    },
  ): Promise<void> {
    if (isTerminal(this.records.get(childSessionId))) return;
    const steering = this.steering.get(childSessionId) ?? [];
    steering.length = 0;
    this.steering.set(childSessionId, steering);
    this.update(childSessionId, {
      ...values,
      approval: undefined,
      currentTool: undefined,
      steeringQueued: 0,
      completedAt: this.now(),
    });
    await this.persist();
    this.notifyWaiters(childSessionId);
  }

  private update(
    childSessionId: string,
    patch: Partial<WorkspaceBackgroundRecord>,
  ): void {
    const current = this.requireRecord(childSessionId);
    this.records.set(childSessionId, {
      ...current,
      ...patch,
      updatedAt: this.now(),
    });
  }

  private requireOwned(
    request: WorkspaceBackgroundTargetRequest,
  ): WorkspaceBackgroundRecord {
    this.assertForegroundCaller(request.callerSessionId);
    const record = this.requireRecord(request.childSessionId);
    if (
      record.parentSessionId !== request.callerSessionId ||
      record.projectId !== this.options.projectId
    ) {
      throw new Error("background_child_not_owned");
    }
    return record;
  }

  private requireRecord(childSessionId: string): WorkspaceBackgroundRecord {
    const record = this.records.get(childSessionId);
    if (!record) throw new Error("background_child_not_found");
    return record;
  }

  private assertForegroundCaller(callerSessionId: string): void {
    if (!callerSessionId.trim()) throw new Error("background_caller_required");
    if (this.records.has(callerSessionId)) {
      throw new Error("background_grandchildren_not_supported");
    }
  }

  private activeCount(): number {
    return [...this.records.values()].filter(isActive).length;
  }

  private assertDisjointWriteReservations(
    scopes: readonly WorkspaceBackgroundPathScope[],
  ): void {
    const requested = scopes.filter((scope) => scope.access === "read_write");
    for (const record of this.records.values()) {
      if (!isActive(record)) continue;
      const existing = record.scopes.filter(
        (scope) => scope.access === "read_write",
      );
      if (
        requested.some((left) =>
          existing.some((right) => overlaps(left, right)),
        )
      ) {
        throw new Error("background_write_scope_overlap");
      }
    }
  }

  private async resolveScopes(
    readScopes: SpawnWorkspaceBackgroundRequest["readScopes"],
    writeScopes: SpawnWorkspaceBackgroundRequest["writeScopes"],
  ): Promise<readonly WorkspaceBackgroundPathScope[]> {
    if (readScopes.length + writeScopes.length === 0) {
      throw new Error("background_scope_required");
    }
    const resolved: WorkspaceBackgroundPathScope[] = [];
    for (const scope of readScopes) {
      resolved.push(await this.resolveScope(scope, "read"));
    }
    for (const scope of writeScopes) {
      resolved.push(await this.resolveScope(scope, "read_write"));
    }
    const unique = new Map(
      resolved.map((scope) => [
        JSON.stringify([scope.path, scope.kind, scope.access]),
        scope,
      ]),
    );
    return [...unique.values()].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }

  private async resolveScope(
    scope: { readonly path: string; readonly kind: "file" | "directory" },
    access: WorkspaceBackgroundPathScope["access"],
  ): Promise<WorkspaceBackgroundPathScope> {
    const normalized = normalizeRelativePath(scope.path);
    const absolute = path.resolve(this.projectRoot, ...normalized.split("/"));
    const canonical = await canonicalizeProspectivePath(absolute);
    if (!isWithin(this.projectRoot, canonical)) {
      throw new Error("background_scope_outside_project");
    }
    const relative = path
      .relative(this.projectRoot, canonical)
      .split(path.sep)
      .join("/");
    return { path: relative || ".", kind: scope.kind, access };
  }

  private async acquireAdmission(): Promise<() => void> {
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private schedulePersist(): void {
    if (this.persistTimer || this.persistError || this.closed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch(() => undefined);
    }, 250);
    this.persistTimer.unref?.();
  }

  private async open(): Promise<void> {
    await fs.mkdir(this.options.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const raw = await fs.readFile(this.statePath, "utf8").catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!raw) return;
    const state = JSON.parse(raw) as DurableState;
    if (
      state.version !== STATE_VERSION ||
      !Array.isArray(state.records) ||
      !state.records.every(validRecord)
    ) {
      throw new Error("background_state_invalid");
    }
    let changed = false;
    for (const stored of state.records) {
      const record = cloneRecord(stored);
      if (isActive(record)) {
        changed = true;
        this.records.set(record.childSessionId, {
          ...record,
          lifecycle: "interrupted",
          phase: "failed",
          resultState: "interrupted",
          approval: undefined,
          currentTool: undefined,
          terminalReason: "host_restarted_during_run",
          completedAt: this.now(),
          updatedAt: this.now(),
          steeringQueued: 0,
        });
        this.steering.set(record.childSessionId, []);
      } else {
        this.records.set(record.childSessionId, record);
        this.steering.set(record.childSessionId, [
          ...(state.steering?.[record.childSessionId] ?? []),
        ]);
      }
    }
    if (changed) await this.persist();
  }

  private settleHostApproval(childSessionId: string, allowed: boolean): void {
    const pending = this.hostApprovals.get(childSessionId);
    if (!pending) return;
    this.hostApprovals.delete(childSessionId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.resolve(allowed);
  }

  private notifyWaiters(childSessionId: string): void {
    const waiters = this.waiters.get(childSessionId);
    this.waiters.delete(childSessionId);
    for (const waiter of waiters ?? []) waiter();
  }

  private persist(): Promise<void> {
    if (this.persistError) return Promise.reject(this.persistError);
    const operation = this.persistTail.then(async () => {
      const state: DurableState = {
        version: 1,
        records: [...this.records.values()].map(cloneRecord),
        steering: Object.fromEntries(
          [...this.steering].map(([id, messages]) => [id, [...messages]]),
        ),
      };
      const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temporary, this.statePath);
        await fs.chmod(this.statePath, 0o600);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.persistTail = operation.catch((error: unknown) => {
      this.persistError = new Error(
        `background_state_persist_failed:${errorCode(error) ?? "unknown"}`,
      );
    });
    return operation;
  }
}

function cloneRecord(
  record: WorkspaceBackgroundRecord,
): WorkspaceBackgroundRecord {
  return structuredClone(record);
}

function isActive(record: WorkspaceBackgroundRecord): boolean {
  return !isTerminal(record);
}

function isTerminal(record: WorkspaceBackgroundRecord | undefined): boolean {
  return Boolean(
    record &&
    (record.lifecycle === "completed" ||
      record.lifecycle === "failed" ||
      record.lifecycle === "cancelled" ||
      record.lifecycle === "interrupted"),
  );
}

function scopeContains(
  scope: WorkspaceBackgroundPathScope,
  relativePath: string,
): boolean {
  return scope.kind === "file"
    ? scope.path === relativePath
    : isRelativeWithin(relativePath, scope.path);
}

function overlaps(
  left: WorkspaceBackgroundPathScope,
  right: WorkspaceBackgroundPathScope,
): boolean {
  return scopeContains(left, right.path) || scopeContains(right, left.path);
}

function isRelativeWithin(candidate: string, root: string): boolean {
  if (root === ".") return true;
  const relative = path.posix.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("../") &&
      !path.posix.isAbsolute(relative))
  );
}

function normalizeRelativePath(value: string): string {
  if (!value?.trim() || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error("background_scope_path_invalid");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error("background_scope_path_invalid");
  }
  return normalized;
}

async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  let current = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(current);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function boundedRequiredText(
  value: string,
  maxBytes: number,
  label: string,
): string {
  const normalized = value?.trim();
  if (!normalized)
    throw new Error(`background_${label.replaceAll(" ", "_")}_required`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new Error(`background_${label.replaceAll(" ", "_")}_too_large`);
  }
  return normalized;
}

function validRecord(value: unknown): value is WorkspaceBackgroundRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<WorkspaceBackgroundRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.childSessionId === "string" &&
    typeof record.parentSessionId === "string" &&
    typeof record.parentTurnId === "string" &&
    typeof record.rootSessionId === "string" &&
    typeof record.projectId === "string" &&
    record.depth === 1 &&
    typeof record.task === "string" &&
    Array.isArray(record.scopes) &&
    record.scopes.every(
      (scope) =>
        Boolean(scope) &&
        typeof scope.path === "string" &&
        (scope.kind === "file" || scope.kind === "directory") &&
        (scope.access === "read" || scope.access === "read_write"),
    ) &&
    typeof record.lifecycle === "string" &&
    typeof record.phase === "string" &&
    typeof record.resultState === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    typeof record.steeringQueued === "number"
  );
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
