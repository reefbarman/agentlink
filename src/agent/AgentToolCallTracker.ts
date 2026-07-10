import { EventEmitter } from "events";

import { type ToolResult } from "../shared/types.js";

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
  terminalId?: string;
  backgroundRequested?: boolean;
}

export interface TrackedCallInfo {
  id: string;
  toolName: string;
  displayArgs: string;
  params?: string;
  startedAt: number;
  status: "active" | "completed";
  completedAt?: number;
  canContinueInBackground?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

// ── AgentToolCallTracker ─────────────────────────────────────────────────────

const COMPLETED_TTL_MS = 8_000;

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
        canContinueInBackground: c.toolName === "execute_command",
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
      if (call.backgroundRequested) {
        void this.detachExecuteCommand(call);
      }
    }
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
  ): TrackerContext {
    const tracked: TrackedCall = {
      id: toolCallId,
      toolName,
      displayArgs,
      params,
      sessionId,
      startedAt: Date.now(),
      forceResolve,
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
    if (!call || call.toolName !== "execute_command") {
      this.log(
        `BACKGROUND_MISS (${id.slice(0, 8)}) — no active execute_command`,
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
      makeToolResult({
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

    if (call.toolName === "execute_command") {
      await this.completeExecuteCommand(call);
      return;
    }

    if (call.toolName === "get_terminal_output") {
      await this.completeGetTerminalOutput(call);
      return;
    }

    if (call.toolName === "write_file" || call.toolName === "apply_diff") {
      await this.completeWriteTool(call);
      return;
    }

    call.forceResolve(
      makeToolResult({
        status: "force-completed",
        tool: call.toolName,
        message: "Force-completed by user from VS Code",
      }),
    );
  }

  private async completeExecuteCommand(call: TrackedCall): Promise<void> {
    this.log(
      `COMPLETE_EXEC ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId ?? "none"}`,
    );
    const { getTerminalManager } =
      await import("../integrations/TerminalManager.js");
    const tm = getTerminalManager();

    let partialOutput = "";
    if (call.terminalId) {
      partialOutput =
        tm.getCurrentOutput(call.terminalId, { force: true }) ?? "";
      this.log(`COMPLETE_EXEC output captured: ${partialOutput.length} chars`);
    }

    // Interrupt the running process
    if (call.terminalId) {
      this.log(`COMPLETE_EXEC interrupting terminal ${call.terminalId}`);
      tm.interruptTerminal(call.terminalId);
    }

    call.forceResolve(
      makeToolResult({
        exit_code: null,
        output: partialOutput || "[No output captured]",
        output_captured: !!partialOutput,
        terminal_id: call.terminalId ?? null,
        status: "force-completed",
        message: "Command force-completed by user. Process was interrupted.",
      }),
    );
  }

  private async completeGetTerminalOutput(call: TrackedCall): Promise<void> {
    // displayArgs is the terminal_id for get_terminal_output
    const terminalId = call.displayArgs;
    this.log(
      `COMPLETE_GET_OUTPUT ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${terminalId}`,
    );

    const { getTerminalManager } =
      await import("../integrations/TerminalManager.js");
    const tm = getTerminalManager();
    const state = tm.getBackgroundState(terminalId);

    if (!state) {
      // Terminal not in managed list — try force-reading output as last resort
      const directOutput = tm.getCurrentOutput(terminalId, { force: true });
      call.forceResolve(
        makeToolResult(
          directOutput
            ? {
                terminal_id: terminalId,
                is_running: false,
                exit_code: null,
                output_captured: true,
                output: directOutput,
                status: "force-completed",
                message:
                  "Output returned immediately — wait was interrupted by user.",
              }
            : {
                error: `Terminal "${terminalId}" not found. It may have been closed.`,
              },
        ),
      );
      return;
    }

    // Use background state output when captured, otherwise force-read
    // the output buffer directly (covers foreground terminals that were
    // never transitioned to background mode).
    const output = state.output_captured
      ? state.output
      : (tm.getCurrentOutput(terminalId, { force: true }) ?? "");

    call.forceResolve(
      makeToolResult({
        terminal_id: terminalId,
        is_running: state.is_running,
        exit_code: state.exit_code,
        output_captured: state.output_captured || !!output,
        output: output || "[No output captured]",
        status: "force-completed",
        message: "Output returned immediately — wait was interrupted by user.",
        ...(!state.output_captured &&
          !output && {
            verification_hint:
              `Terminal_id "${terminalId}" did not have shell integration capture available. ` +
              "Use the visible terminal to verify command state rather than re-running it.",
          }),
      }),
    );
  }

  private async completeWriteTool(call: TrackedCall): Promise<void> {
    this.log(`COMPLETE_WRITE ${call.toolName} (${call.id.slice(0, 8)})`);
    const { resolveCurrentDiff } =
      await import("../integrations/DiffViewProvider.js");

    // Try to auto-accept the pending diff — if successful the original
    // handler will complete naturally through saveChanges().
    if (resolveCurrentDiff("accept")) {
      this.log(`COMPLETE_WRITE auto-accepted diff for ${call.toolName}`);
      return; // Original handler wins the Promise.race
    }
    this.log(
      `COMPLETE_WRITE no pending diff, force-resolving ${call.toolName}`,
    );

    // No pending diff — force-resolve with fallback
    call.forceResolve(
      makeToolResult({
        status: "force-completed",
        path: call.displayArgs,
        message:
          "No pending diff to accept — file may already be saved or approval was not yet shown",
      }),
    );
  }
}
