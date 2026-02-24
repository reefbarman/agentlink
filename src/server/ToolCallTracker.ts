import { EventEmitter } from "events";
import { randomUUID } from "crypto";

import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export interface TrackerContext {
  toolCallId: string;
  setApprovalId: (approvalId: string) => void;
  setTerminalId: (terminalId: string) => void;
}

export interface TrackedCall {
  id: string;
  toolName: string;
  displayArgs: string;
  sessionId: string;
  startedAt: number;
  forceResolve: (result: ToolResult) => void;
  approvalId?: string;
  terminalId?: string;
}

export interface TrackedCallInfo {
  id: string;
  toolName: string;
  displayArgs: string;
  startedAt: number;
  status: "active" | "completed";
  completedAt?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

// ── ToolCallTracker ──────────────────────────────────────────────────────────

const COMPLETED_TTL_MS = 8_000;

export class ToolCallTracker extends EventEmitter {
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
        startedAt: c.startedAt,
        status: "active" as const,
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

  setApprovalId(toolCallId: string, approvalId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (call) {
      call.approvalId = approvalId;
      this.log(`WAITING_APPROVAL ${call.toolName} (${toolCallId.slice(0, 8)}), approvalId=${approvalId.slice(0, 8)}`);
    }
  }

  setTerminalId(toolCallId: string, terminalId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (call) {
      call.terminalId = terminalId;
      this.log(`TERMINAL_ASSIGNED ${call.toolName} (${toolCallId.slice(0, 8)}), terminalId=${terminalId}`);
    }
  }

  /**
   * Wrap a tool handler with tracking.  Returns a new handler that:
   * 1. Registers the call in the active set
   * 2. Races the original handler against a force-resolve promise
   * 3. Cleans up in `finally`
   *
   * The returned handler has an extra `trackerCtx` argument that tool
   * handlers can optionally accept to link approvals/terminals.
   */
  wrapHandler<P extends Record<string, unknown> = Record<string, unknown>>(
    toolName: string,
    handler: (params: P, trackerCtx: TrackerContext) => Promise<ToolResult>,
    extractDisplayArgs: (params: P) => string,
    getSessionId: () => string,
  ): (params: P) => Promise<ToolResult> {
    return async (params: P) => {
      const id = randomUUID();
      let forceResolve!: (result: ToolResult) => void;
      const forcePromise = new Promise<ToolResult>((resolve) => {
        forceResolve = resolve;
      });

      const tracked: TrackedCall = {
        id,
        toolName,
        displayArgs: extractDisplayArgs(params),
        sessionId: getSessionId(),
        startedAt: Date.now(),
        forceResolve,
      };

      const ctx: TrackerContext = {
        toolCallId: id,
        setApprovalId: (approvalId) => this.setApprovalId(id, approvalId),
        setTerminalId: (terminalId) => this.setTerminalId(id, terminalId),
      };

      this.activeCalls.set(id, tracked);
      this.log(
        `START ${toolName} (${id.slice(0, 8)}), active=${this.activeCalls.size}, listeners=${this.listenerCount("change")}`,
      );
      this.emit("change");

      try {
        return await Promise.race([handler(params, ctx), forcePromise]);
      } finally {
        const completed = this.activeCalls.get(id);
        this.activeCalls.delete(id);
        if (completed) this.markCompleted(completed);
        this.log(
          `END ${toolName} (${id.slice(0, 8)}), active=${this.activeCalls.size}, recent=${this.recentCalls.size}`,
        );
        this.emit("change");
      }
    };
  }

  // ── Cancel ───────────────────────────────────────────────────────────────

  cancelCall(id: string, approvalPanel: ApprovalPanelProvider): void {
    const call = this.activeCalls.get(id);
    if (!call) {
      this.log(`CANCEL_MISS (${id.slice(0, 8)}) — not found in active calls`);
      return;
    }

    this.log(`CANCEL ${call.toolName} (${id.slice(0, 8)})`);

    // Kill the running terminal process if applicable
    if (call.terminalId) {
      this.log(`CANCEL_INTERRUPT terminal ${call.terminalId}`);
      import("../integrations/TerminalManager.js").then(
        ({ getTerminalManager }) => {
          getTerminalManager().interruptTerminal(call.terminalId!);
        },
      );
    }

    // Cancel any linked approval
    if (call.approvalId) {
      this.log(`CANCEL_APPROVAL ${call.toolName} (${id.slice(0, 8)}), approvalId=${call.approvalId.slice(0, 8)}`);
      approvalPanel.cancelApproval(call.approvalId);
    }

    // Reject any pending diff
    import("../integrations/DiffViewProvider.js").then(
      ({ resolveCurrentDiff }) => {
        resolveCurrentDiff("reject");
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

  async completeCall(
    id: string,
    approvalPanel: ApprovalPanelProvider,
  ): Promise<void> {
    const call = this.activeCalls.get(id);
    if (!call) {
      this.log(`COMPLETE_MISS (${id.slice(0, 8)}) — not found in active calls`);
      return;
    }

    this.log(`COMPLETE ${call.toolName} (${id.slice(0, 8)})`);

    if (call.toolName === "execute_command") {
      await this.completeExecuteCommand(call);
      return;
    }

    if (call.toolName === "write_file" || call.toolName === "apply_diff") {
      await this.completeWriteTool(call);
      return;
    }

    // All other tools: cancel any approval, then force-resolve
    if (call.approvalId) {
      approvalPanel.cancelApproval(call.approvalId);
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
    this.log(`COMPLETE_EXEC ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId ?? "none"}`);
    const { getTerminalManager } =
      await import("../integrations/TerminalManager.js");
    const tm = getTerminalManager();

    let partialOutput = "";
    if (call.terminalId) {
      partialOutput = tm.getCurrentOutput(call.terminalId) ?? "";
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
        message:
          "Command force-completed by user. Process was interrupted.",
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
    this.log(`COMPLETE_WRITE no pending diff, force-resolving ${call.toolName}`);

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
