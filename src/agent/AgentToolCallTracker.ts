import { EventEmitter } from "events";

import { successResult, type ToolResult } from "../shared/types.js";
import { getAgentToolCompletionStrategy } from "./agentToolCompletionStrategies.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrackerContext {
  toolCallId: string;
  setTerminalId: (terminalId: string) => void;
}

export interface TrackedCall {
  id: string;
  toolName: string;
  displayArgs: string;
  params?: string;
  sessionId: string;
  startedAt: number;
  forceResolve: (result: ToolResult) => void;
  parentCallId?: string;
  terminalId?: string;
  backgroundRequested?: boolean;
  revealTerminalRequested?: boolean;
}

export interface TrackedCallInfo {
  id: string;
  toolName: string;
  displayArgs: string;
  params?: string;
  startedAt: number;
  status: "active" | "completed";
  completedAt?: number;
  parentCallId?: string;
  canContinueInBackground?: boolean;
}

// ── AgentToolCallTracker ─────────────────────────────────────────────────────

const COMPLETED_TTL_MS = 8_000;
const BACKGROUND_CONTINUABLE_TOOLS = new Set([
  "execute_command",
  "get_background_result",
]);

function canContinueInBackground(toolName: string): boolean {
  return BACKGROUND_CONTINUABLE_TOOLS.has(toolName);
}

export class AgentToolCallTracker extends EventEmitter {
  private activeCalls = new Map<string, TrackedCall>();
  private recentCalls = new Map<string, TrackedCallInfo>();
  private log: (msg: string) => void;

  constructor(log?: (msg: string) => void) {
    super();
    this.log = log ?? (() => {});
  }

  getActiveCalls(): TrackedCallInfo[] {
    const active: TrackedCallInfo[] = [...this.activeCalls.values()].map(
      (c) => ({
        id: c.id,
        toolName: c.toolName,
        displayArgs: c.displayArgs,
        params: c.params,
        startedAt: c.startedAt,
        status: "active" as const,
        parentCallId: c.parentCallId,
        canContinueInBackground: canContinueInBackground(c.toolName),
      }),
    );
    const recent: TrackedCallInfo[] = [...this.recentCalls.values()];
    return [...active, ...recent];
  }

  private markCompleted(call: TrackedCall): void {
    const info: TrackedCallInfo = {
      id: call.id,
      toolName: call.toolName,
      displayArgs: call.displayArgs,
      params: call.params,
      startedAt: call.startedAt,
      status: "completed",
      completedAt: Date.now(),
      parentCallId: call.parentCallId,
    };
    this.recentCalls.set(call.id, info);
    setTimeout(() => {
      this.recentCalls.delete(call.id);
      this.emit("change");
    }, COMPLETED_TTL_MS);
  }

  setTerminalId(toolCallId: string, terminalId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (call) {
      call.terminalId = terminalId;
      this.log(
        `TERMINAL_ASSIGNED ${call.toolName} (${toolCallId.slice(0, 8)}), terminalId=${terminalId}`,
      );
      if (call.backgroundRequested) void this.detachExecuteCommand(call);
      if (call.revealTerminalRequested) {
        void this.revealExecuteCommandTerminal(call);
      }
    }
  }

  /** Reveal the managed terminal backing a running execute_command call. */
  revealTerminal(id: string): void {
    const call = this.activeCalls.get(id);
    if (!call || call.toolName !== "execute_command") {
      this.log(
        `REVEAL_TERMINAL_MISS (${id.slice(0, 8)}) — no active execute_command tool`,
      );
      return;
    }

    call.revealTerminalRequested = true;
    if (call.terminalId) void this.revealExecuteCommandTerminal(call);
  }

  private async revealExecuteCommandTerminal(call: TrackedCall): Promise<void> {
    if (!call.terminalId) return;
    const { getTerminalManager } =
      await import("../integrations/TerminalManager.js");
    const revealed = getTerminalManager().revealTerminal(call.terminalId);
    this.log(
      `REVEAL_TERMINAL ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId}, revealed=${revealed}`,
    );
  }

  // ── Agent call registration (lightweight — no wrapping) ──────────────────

  /**
   * Register an agent tool call so it appears in the sidebar's active tools list.
   * The caller owns the actual tool execution and passes a forceResolve hook
   * that can be triggered from the sidebar's Complete/Cancel buttons.
   */
  registerAgentCall(
    toolCallId: string,
    toolName: string,
    displayArgs: string,
    sessionId: string,
    forceResolve: (result: ToolResult) => void,
    params?: string,
    parentCallId?: string,
  ): TrackerContext {
    const tracked: TrackedCall = {
      id: toolCallId,
      toolName,
      displayArgs,
      params,
      sessionId,
      startedAt: Date.now(),
      forceResolve,
      parentCallId,
    };
    this.activeCalls.set(toolCallId, tracked);
    this.log(
      `AGENT_START ${toolName} (${toolCallId.slice(0, 8)}), active=${this.activeCalls.size}`,
    );
    this.emit("change");
    return {
      toolCallId,
      setTerminalId: (terminalId) => this.setTerminalId(toolCallId, terminalId),
    };
  }

  /**
   * Mark an agent tool call as completed. Moves it to the recent list with TTL.
   */
  completeAgentCall(toolCallId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (!call) return;
    this.activeCalls.delete(toolCallId);
    this.markCompleted(call);
    this.log(
      `AGENT_END ${call.toolName} (${toolCallId.slice(0, 8)}), active=${this.activeCalls.size}, recent=${this.recentCalls.size}`,
    );
    this.emit("change");
  }

  /**
   * Remove all active agent calls for a given session (e.g. when the session is stopped).
   */
  clearAgentCalls(sessionId: string): void {
    let removed = 0;
    for (const [id, call] of this.activeCalls) {
      if (call.sessionId === sessionId) {
        this.activeCalls.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.log(
        `AGENT_CLEAR sessionId=${sessionId.slice(0, 8)}, removed=${removed}, active=${this.activeCalls.size}`,
      );
      this.emit("change");
    }
  }

  // ── Continue in background ──────────────────────────────────────────────

  continueInBackground(id: string): void {
    const call = this.activeCalls.get(id);
    if (!call || !canContinueInBackground(call.toolName)) {
      this.log(
        `BACKGROUND_MISS (${id.slice(0, 8)}) — no active background-continuable tool`,
      );
      return;
    }

    if (call.toolName === "get_background_result") {
      let backgroundSessionId: string | undefined;
      try {
        const params = call.params ? JSON.parse(call.params) : undefined;
        if (typeof params?.sessionId === "string") {
          backgroundSessionId = params.sessionId;
        }
      } catch {
        // The handoff still works without the session ID in the result payload.
      }

      this.log(
        `BACKGROUND_RETURN ${call.toolName} (${id.slice(0, 8)}), sessionId=${backgroundSessionId ?? "unknown"}`,
      );
      call.forceResolve(
        successResult({
          status: "continued-in-background",
          done: false,
          ...(backgroundSessionId ? { sessionId: backgroundSessionId } : {}),
          message:
            "Returned control to the agent. The background agent is still running; use get_background_status to check progress or get_background_result when ready to wait again.",
        }),
      );
      return;
    }

    call.backgroundRequested = true;
    this.log(
      `BACKGROUND_REQUEST ${call.toolName} (${id.slice(0, 8)}), terminalId=${call.terminalId ?? "pending"}`,
    );
    if (call.terminalId) {
      void this.detachExecuteCommand(call);
    }
  }

  private async detachExecuteCommand(call: TrackedCall): Promise<void> {
    if (!call.terminalId) return;
    const { getTerminalManager } =
      await import("../integrations/TerminalManager.js");
    const detached = getTerminalManager().detachTerminal(call.terminalId);
    this.log(
      `BACKGROUND_DETACH ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId}, detached=${detached}`,
    );
  }

  // ── Cancel ───────────────────────────────────────────────────────────────

  cancelCall(id: string): void {
    const call = this.activeCalls.get(id);
    if (!call) {
      this.log(`CANCEL_MISS (${id.slice(0, 8)}) — not found in active calls`);
      return;
    }

    this.log(`CANCEL_AGENT ${call.toolName} (${id.slice(0, 8)})`);

    const descendantIds = new Set([id]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const active of this.activeCalls.values()) {
        if (
          active.parentCallId &&
          descendantIds.has(active.parentCallId) &&
          !descendantIds.has(active.id)
        ) {
          descendantIds.add(active.id);
          foundDescendant = true;
        }
      }
    }
    for (const descendantId of descendantIds) {
      if (descendantId === id) continue;
      const descendant = this.activeCalls.get(descendantId);
      descendant?.forceResolve(
        successResult({
          status: "cancelled",
          tool: descendant.toolName,
          message: "Cancelled with parent tool call",
        }),
      );
    }

    // Kill the running terminal process if applicable
    if (call.terminalId) {
      this.log(`CANCEL_INTERRUPT terminal ${call.terminalId}`);
      import("../integrations/TerminalManager.js").then(
        ({ getTerminalManager }) => {
          getTerminalManager().interruptTerminal(call.terminalId!);
        },
        (err) => {
          this.log(`CANCEL_INTERRUPT import failed: ${err}`);
        },
      );
    }

    // Reject any pending diff
    import("../integrations/DiffViewProvider.js").then(
      ({ resolveCurrentDiff }) => {
        resolveCurrentDiff("reject");
      },
      (err) => {
        this.log(`CANCEL_DIFF import failed: ${err}`);
      },
    );

    // Force-resolve with cancelled result
    call.forceResolve(
      successResult({
        status: "cancelled",
        tool: call.toolName,
        message: "Cancelled by user from VS Code",
      }),
    );
  }

  // ── Complete (smart recovery) ────────────────────────────────────────────

  async completeCall(id: string): Promise<void> {
    const call = this.activeCalls.get(id);
    if (!call) {
      this.log(`COMPLETE_MISS (${id.slice(0, 8)}) — not found in active calls`);
      return;
    }

    this.log(`COMPLETE_AGENT ${call.toolName} (${id.slice(0, 8)})`);

    const strategy = getAgentToolCompletionStrategy(call.toolName);
    await strategy(call, this.log);
  }
}
