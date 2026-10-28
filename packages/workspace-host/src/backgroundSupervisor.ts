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

import { appendOwnershipHandoff } from "@agentlink/core/background-agent-tools";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STATE_VERSION = 1;
const STATE_FILE = "background-agents.json";
/** Active children a foreground session may have when the host sets none. */
export const DEFAULT_MAX_ACTIVE_BACKGROUND_CHILDREN = 2;
/** The most active children any host may allow. */
export const MAX_ACTIVE_BACKGROUND_CHILDREN = 8;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TASK_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_STEERING_MESSAGES = 8;
/**
 * Tool names come from the model before the engine checks them, so only
 * identifier-shaped names are recorded; anything else is reported unnamed.
 */
const REPORTABLE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;

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

export interface WorkspaceBackgroundForbiddenPath {
  readonly path: string;
  readonly kind: "file" | "directory";
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
  /**
   * Paths the child must not modify, even inside its write scopes (VS Code's
   * `forbiddenPaths`). Absent on records written before they existed.
   */
  readonly forbidden?: readonly WorkspaceBackgroundForbiddenPath[];
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
  /**
   * What the child may read. When absent, it may read the whole project
   * (still limited to what its parent can read).
   */
  readonly readScopes?: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
  }[];
  readonly writeScopes?: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
  }[];
  /**
   * VS Code's `ownedPaths`: project-relative (or absolute in-project) files
   * and directories the child may write. A trailing slash or an existing
   * directory makes a directory scope. Without any, the child is read-only.
   */
  readonly ownedPaths?: readonly string[];
  /** VS Code's `forbiddenPaths`: never writable, even inside owned paths. */
  readonly forbiddenPaths?: readonly string[];
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

export interface WorkspaceBackgroundWaitManyRequest {
  readonly callerSessionId: string;
  readonly childSessionIds: readonly string[];
  readonly returnWhen: "any" | "all";
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceBackgroundWaitManyResult {
  readonly status: "completed" | "still_running" | "wait_cancelled";
  /** One record per distinct requested child, in request order. */
  readonly records: readonly WorkspaceBackgroundRecord[];
}

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
  /** Children one foreground session may have active at once. */
  readonly maxActiveChildren?: number;
  /**
   * What a child spawned without read scopes may read: everything its parent
   * can. Without this, the whole project.
   */
  readonly resolveParentReadScopes?: (request: {
    readonly parentSessionId: string;
    readonly parentTurnId: string;
  }) => Promise<
    readonly { readonly path: string; readonly kind: "file" | "directory" }[]
  >;
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
  /**
   * Called synchronously after a child's lifecycle, phase, or current tool
   * changes. Output deltas alone never fire it. Listener failures are ignored
   * so a subscriber cannot break supervision.
   */
  readonly onAgentChanged?: (change: WorkspaceBackgroundChange) => void;
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

export interface WorkspaceBackgroundChange {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly lifecycle: WorkspaceBackgroundLifecycle;
  readonly phase: BackgroundAgentRuntimePhase;
  readonly resultState: BackgroundResultState;
  readonly currentTool?: string;
}

interface LiveBackgroundChild {
  readonly controller: AbortController;
  running?: Promise<void>;
  streamedOutput: boolean;
  /** Tool calls started but not yet completed or failed, in start order. */
  readonly activeTools: Map<string, string | undefined>;
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
    const limit =
      options.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_BACKGROUND_CHILDREN;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_ACTIVE_BACKGROUND_CHILDREN
    ) {
      throw new Error("background_max_active_children_invalid");
    }
    this.maxActiveChildren = limit;
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

  /** How many children may be active at once. */
  get activeChildLimit(): number {
    return this.maxActiveChildren;
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
      if (this.activeCount(request.callerSessionId) >= this.maxActiveChildren) {
        throw new Error("background_child_capacity_reached");
      }
      const task = boundedRequiredText(request.task, MAX_TASK_BYTES, "task");
      const message = boundedRequiredText(
        request.message,
        MAX_MESSAGE_BYTES,
        "message",
      );
      // No write scopes makes a read-only child (for example a reviewer):
      // `assertWriteAllowed` refuses every write it attempts.
      const ownedScopes = await Promise.all(
        (request.ownedPaths ?? []).map((value) =>
          this.resolvePathString(value, "read_write"),
        ),
      );
      const forbidden = (
        await Promise.all(
          (request.forbiddenPaths ?? []).map((value) =>
            this.resolvePathString(value, "read"),
          ),
        )
      ).map(({ path: scopePath, kind }) => ({ path: scopePath, kind }));
      const readScopes =
        request.readScopes ??
        (await this.options.resolveParentReadScopes?.({
          parentSessionId: request.callerSessionId,
          parentTurnId: request.callerTurnId,
        })) ??
        ([{ path: ".", kind: "directory" }] as const);
      const scopes = await this.resolveScopes(readScopes, [
        ...(request.writeScopes ?? []),
        ...ownedScopes,
      ]);
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
        ...(forbidden.length > 0 ? { forbidden: uniquePaths(forbidden) } : {}),
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
      // As in VS Code, a child given ownership is told its paths, which the
      // host enforces.
      const handoff =
        request.ownedPaths !== undefined || request.forbiddenPaths !== undefined
          ? appendOwnershipHandoff(message, {
              ownedPaths: scopes
                .filter((scope) => scope.access === "read_write")
                .map((scope) => scope.path),
              forbiddenPaths: (record.forbidden ?? []).map(
                (entry) => entry.path,
              ),
              backend: "workspace",
              executionRoot: this.projectRoot,
            })
          : message;
      this.startRun(record.childSessionId, handoff, false);
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

  /**
   * Wait for several directly owned children until any or all of them have
   * finished, the bounded wait expires, or the call is cancelled. Every child
   * is authorized before waiting, so a denied request waits for nothing.
   */
  async waitMany(
    request: WorkspaceBackgroundWaitManyRequest,
  ): Promise<WorkspaceBackgroundWaitManyResult> {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("background_wait_timeout_invalid");
    }
    const childSessionIds = [...new Set(request.childSessionIds)];
    if (childSessionIds.length === 0) {
      throw new Error("background_session_ids_required");
    }
    const target = (childSessionId: string) => ({
      callerSessionId: request.callerSessionId,
      childSessionId,
    });
    for (const childSessionId of childSessionIds) {
      this.requireOwned(target(childSessionId));
    }
    const satisfied = () => {
      const finished = childSessionIds.filter((childSessionId) =>
        isTerminal(this.records.get(childSessionId)),
      ).length;
      return request.returnWhen === "any"
        ? finished > 0
        : finished === childSessionIds.length;
    };
    const snapshot = (status: WorkspaceBackgroundWaitManyResult["status"]) => ({
      status,
      records: childSessionIds.map((childSessionId) =>
        cloneRecord(this.requireOwned(target(childSessionId))),
      ),
    });
    if (satisfied()) return snapshot("completed");
    if (request.signal?.aborted) return snapshot("wait_cancelled");
    const outcome = await new Promise<"changed" | "timeout" | "cancelled">(
      (resolve) => {
        let settled = false;
        const finish = (value: "changed" | "timeout" | "cancelled") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          for (const childSessionId of childSessionIds) {
            const waiters = this.waiters.get(childSessionId);
            waiters?.delete(onChanged);
            if (waiters?.size === 0) this.waiters.delete(childSessionId);
          }
          resolve(value);
        };
        const onChanged = () => {
          if (satisfied()) finish("changed");
        };
        const onAbort = () => finish("cancelled");
        const timer = setTimeout(() => finish("timeout"), request.timeoutMs);
        timer.unref?.();
        for (const childSessionId of childSessionIds) {
          const waiters = this.waiters.get(childSessionId) ?? new Set();
          waiters.add(onChanged);
          this.waiters.set(childSessionId, waiters);
        }
        request.signal?.addEventListener("abort", onAbort, { once: true });
        onChanged();
      },
    );
    if (satisfied()) return snapshot("completed");
    return snapshot(
      outcome === "cancelled" ? "wait_cancelled" : "still_running",
    );
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

  /**
   * Forget every child of a foreground session that is being deleted: their
   * records and queued steering leave memory and the state file. Refused
   * while any of them is still running. Returns the children's session IDs,
   * which the caller deletes from the session store.
   */
  async forgetParent(parentSessionId: string): Promise<readonly string[]> {
    const children = [...this.records.values()].filter(
      (record) => record.parentSessionId === parentSessionId,
    );
    if (children.some(isActive)) throw new Error("background_child_running");
    for (const child of children) {
      this.records.delete(child.childSessionId);
      this.steering.delete(child.childSessionId);
      this.live.delete(child.childSessionId);
      this.notifyWaiters(child.childSessionId);
    }
    if (children.length > 0) await this.persist();
    return children.map((child) => child.childSessionId);
  }

  assertWriteAllowed(sessionId: string, relativePath: string): boolean {
    const child = this.records.get(sessionId);
    if (child) {
      if (!isActive(child)) return false;
      if (
        child.forbidden?.some((entry) =>
          scopeContains({ ...entry, access: "read" }, relativePath),
        )
      ) {
        return false;
      }
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
      activeTools: new Map<string, string | undefined>(),
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
    if (live) {
      live.streamedOutput = false;
      live.activeTools.clear();
    }
    this.update(childSessionId, {
      lifecycle: "running",
      phase: "waiting_for_provider",
      currentTool: undefined,
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
    // A stopped run may still deliver late events; terminal state is final.
    if (isTerminal(this.records.get(childSessionId))) return;
    const live = this.live.get(childSessionId);
    if (event.type === "text.delta") {
      if (live) live.streamedOutput = true;
      this.appendOutput(childSessionId, event.text);
      this.update(childSessionId, {
        phase: "responding",
        currentTool: undefined,
      });
    } else if (event.type === "tool.started") {
      const toolName = REPORTABLE_TOOL_NAME.test(event.toolName)
        ? event.toolName
        : undefined;
      live?.activeTools.set(event.toolCallId, toolName);
      this.update(childSessionId, {
        phase: "executing_tool",
        currentTool: toolName,
      });
    } else if (
      event.type === "tool.completed" ||
      event.type === "tool.failed"
    ) {
      live?.activeTools.delete(event.toolCallId);
      const remaining = [...(live?.activeTools.values() ?? [])];
      this.update(childSessionId, {
        phase: remaining.length > 0 ? "executing_tool" : "waiting_for_provider",
        currentTool: remaining.at(-1),
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
    const next: WorkspaceBackgroundRecord = {
      ...current,
      ...patch,
      updatedAt: this.now(),
    };
    this.records.set(childSessionId, next);
    if (
      this.options.onAgentChanged &&
      (next.lifecycle !== current.lifecycle ||
        next.phase !== current.phase ||
        next.currentTool !== current.currentTool)
    ) {
      try {
        this.options.onAgentChanged({
          parentSessionId: next.parentSessionId,
          childSessionId,
          lifecycle: next.lifecycle,
          phase: next.phase,
          resultState: next.resultState,
          ...(next.currentTool ? { currentTool: next.currentTool } : {}),
        });
      } catch {
        // Subscribers are best effort; supervision must not depend on them.
      }
    }
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

  /** Active children of one foreground session; write overlap stays global. */
  private activeCount(parentSessionId: string): number {
    return [...this.records.values()].filter(
      (record) =>
        record.parentSessionId === parentSessionId && isActive(record),
    ).length;
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
    readScopes: NonNullable<SpawnWorkspaceBackgroundRequest["readScopes"]>,
    writeScopes: NonNullable<SpawnWorkspaceBackgroundRequest["writeScopes"]>,
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

  /**
   * A path string from `ownedPaths` or `forbiddenPaths` as a scope: absolute
   * paths must be inside the project, and a trailing slash or an existing
   * directory makes a directory scope.
   */
  private async resolvePathString(
    value: string,
    access: WorkspaceBackgroundPathScope["access"],
  ): Promise<WorkspaceBackgroundPathScope> {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      throw new Error("background_scope_path_invalid");
    }
    let relative = value.trim();
    if (path.isAbsolute(relative)) {
      relative = path.relative(this.projectRoot, path.resolve(relative));
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error("background_scope_outside_project");
      }
      relative = relative.split(path.sep).join("/") || ".";
    }
    const normalized = normalizeRelativePath(relative);
    const directory =
      /[\\/]$/u.test(relative) ||
      normalized === "." ||
      (await fs
        .stat(path.resolve(this.projectRoot, ...normalized.split("/")))
        .then((stats) => stats.isDirectory())
        .catch(() => false));
    return await this.resolveScope(
      { path: normalized, kind: directory ? "directory" : "file" },
      access,
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
    (record.forbidden === undefined ||
      (Array.isArray(record.forbidden) &&
        record.forbidden.every(
          (entry) =>
            Boolean(entry) &&
            typeof entry.path === "string" &&
            (entry.kind === "file" || entry.kind === "directory"),
        ))) &&
    typeof record.lifecycle === "string" &&
    typeof record.phase === "string" &&
    typeof record.resultState === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    typeof record.steeringQueued === "number"
  );
}

function uniquePaths(
  entries: readonly WorkspaceBackgroundForbiddenPath[],
): WorkspaceBackgroundForbiddenPath[] {
  return [
    ...new Map(
      entries.map((entry) => [JSON.stringify([entry.path, entry.kind]), entry]),
    ).values(),
  ].sort((left, right) => left.path.localeCompare(right.path));
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
