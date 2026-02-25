import { EventEmitter } from "events";
import { randomUUID } from "crypto";

import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const MAX_LOG_STRING_CHARS = 240;
const MAX_LOG_JSON_CHARS = 1_200;
const MAX_LOG_COLLECTION_ITEMS = 20;
const MAX_LOG_DEPTH = 3;

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
  lastHeartbeatAt?: number;
}

export interface TrackedCallInfo {
  id: string;
  toolName: string;
  displayArgs: string;
  startedAt: number;
  status: "active" | "completed";
  completedAt?: number;
  lastHeartbeatAt?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function truncateLogString(input: string, max = MAX_LOG_STRING_CHARS): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}… [truncated ${input.length - max} chars]`;
}

function sanitizeParamsForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateLogString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    return `[function ${fn.name || "anonymous"}]`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateLogString(value.message),
    };
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_DEPTH) return `[array(${value.length})]`;
    const items = value
      .slice(0, MAX_LOG_COLLECTION_ITEMS)
      .map((item) => sanitizeParamsForLog(item, depth + 1));
    if (value.length > MAX_LOG_COLLECTION_ITEMS) {
      items.push(`[${value.length - MAX_LOG_COLLECTION_ITEMS} more items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    if (depth >= MAX_LOG_DEPTH) return "[object]";
    const entries = Object.entries(value as Record<string, unknown>);
    const trimmed = entries.slice(0, MAX_LOG_COLLECTION_ITEMS);
    const result: Record<string, unknown> = {};
    for (const [k, v] of trimmed) {
      result[k] = sanitizeParamsForLog(v, depth + 1);
    }
    if (entries.length > MAX_LOG_COLLECTION_ITEMS) {
      result.__truncated_keys__ = `${entries.length - MAX_LOG_COLLECTION_ITEMS} more keys`;
    }
    return result;
  }

  return String(value);
}

function formatParamsForLog(params: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(sanitizeParamsForLog(params));
    if (!json) return "{}";
    return truncateLogString(json, MAX_LOG_JSON_CHARS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[unserializable params: ${truncateLogString(message)}]`;
  }
}

// ── ToolCallTracker ──────────────────────────────────────────────────────────

const COMPLETED_TTL_MS = 8_000;

// Interval for SSE heartbeat notifications to prevent client idle timeouts.
// Claude Code drops the POST SSE stream after ~2.5min of inactivity.
// Sending periodic notifications keeps data flowing on the stream.
const HEARTBEAT_INTERVAL_MS = 20_000; // 20 seconds

// Minimal type for the MCP handler's `extra` argument — just what we need
// for heartbeating. The full type is RequestHandlerExtra<ServerNotification, ...>.
interface McpHandlerExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: unknown) => Promise<void>;
}

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
        lastHeartbeatAt: c.lastHeartbeatAt,
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
      this.log(
        `WAITING_APPROVAL ${call.toolName} (${toolCallId.slice(0, 8)}), approvalId=${approvalId.slice(0, 8)}`,
      );
    }
  }

  setTerminalId(toolCallId: string, terminalId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (call) {
      call.terminalId = terminalId;
      this.log(
        `TERMINAL_ASSIGNED ${call.toolName} (${toolCallId.slice(0, 8)}), terminalId=${terminalId}`,
      );
    }
  }

  /**
   * Wrap a tool handler with tracking.  Returns a new handler that:
   * 1. Registers the call in the active set
   * 2. Races the original handler against a force-resolve promise
   * 3. Sends periodic SSE heartbeat notifications to prevent client idle timeouts
   * 4. Cleans up in `finally`
   *
   * The returned handler accepts the MCP `extra` argument (second arg from
   * McpServer.tool()) to access `sendNotification` for heartbeating.
   */
  wrapHandler<P extends Record<string, unknown> = Record<string, unknown>>(
    toolName: string,
    handler: (params: P, trackerCtx: TrackerContext) => Promise<ToolResult>,
    extractDisplayArgs: (params: P) => string,
    getSessionId: () => string,
  ): (params: P, extra?: McpHandlerExtra) => Promise<ToolResult> {
    return async (params: P, extra?: McpHandlerExtra) => {
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
      const paramsSummary = formatParamsForLog(params);
      this.log(
        `START ${toolName} (${id.slice(0, 8)}), active=${this.activeCalls.size}, listeners=${this.listenerCount("change")}, params=${paramsSummary}`,
      );
      this.emit("change");

      // Start SSE heartbeat to prevent client idle timeouts (~2.5min).
      // Notifications sent via extra.sendNotification are routed to the
      // POST SSE stream (via relatedRequestId), keeping it alive.
      // Send an immediate first heartbeat so the connection stays alive
      // during approval waits (which can exceed the command timeout value).
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (extra?.sendNotification) {
        let tick = 0;
        const progressToken = extra._meta?.progressToken;

        // Immediate first heartbeat — prevents client-side timeout during approval
        const sendHeartbeat = async () => {
          tick++;
          try {
            if (progressToken) {
              await extra.sendNotification!({
                method: "notifications/progress",
                params: { progressToken, progress: tick },
              });
            } else {
              await extra.sendNotification!({
                method: "notifications/message",
                params: {
                  level: "debug",
                  logger: "native-claude",
                  data: `${toolName}: processing… (${tick * (HEARTBEAT_INTERVAL_MS / 1000)}s)`,
                },
              });
            }
            tracked.lastHeartbeatAt = Date.now();
            this.emit("change");
          } catch {
            // Connection gone — stop heartbeating
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = undefined;
          }
        };

        // Send immediately, then continue on interval
        sendHeartbeat();
        heartbeat = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      }

      try {
        return await Promise.race([handler(params, ctx), forcePromise]);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
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
      this.log(
        `CANCEL_APPROVAL ${call.toolName} (${id.slice(0, 8)}), approvalId=${call.approvalId.slice(0, 8)}`,
      );
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
    this.log(
      `COMPLETE_EXEC ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId ?? "none"}`,
    );
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
        message: "Command force-completed by user. Process was interrupted.",
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
