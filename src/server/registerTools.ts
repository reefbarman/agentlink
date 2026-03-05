import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolCallTracker } from "./ToolCallTracker.js";
import {
  TOOL_REGISTRY,
  TOOL_NAMES,
  DEV_TOOL_NAMES,
} from "../shared/toolRegistry.js";
import {
  registerSessionTools,
  registerFileTools,
  registerLanguageTools,
  registerWriteTools,
  registerTerminalTools,
  registerSearchTools,
  registerDevTools,
} from "./tools/index.js";
import type { ToolRegistrationContext } from "./tools/types.js";

import { type ToolResult } from "../shared/types.js";

/** Closures for per-session trust state, provided by McpServerHost. */
export interface TrustGate {
  isSessionTrusted: () => boolean;
  markSessionTrusted: () => void;
  getTrustAttempts: () => number;
  incrementTrustAttempts: () => void;
}

/** Look up a tool's description from the registry. Throws if not found. */
function desc(name: string): string {
  const entry = TOOL_REGISTRY[name];
  if (!entry) throw new Error(`Tool "${name}" not found in TOOL_REGISTRY`);
  return entry.description;
}

export function registerTools(
  server: McpServer,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  getSessionId: () => string | undefined,
  tracker: ToolCallTracker,
  extensionUri: import("vscode").Uri,
  trust: TrustGate,
): void {
  const sid = () => getSessionId() ?? "unknown";
  const touch = () => approvalManager.touchSession(sid());
  const log = (msg: string) => console.log(`[AgentLink] ${msg}`);

  /**
   * Trust gate — returns a rejection ToolResult for untrusted sessions,
   * or null if the session is trusted.  Used as a gate in ToolCallTracker
   * so rejected calls still appear in the sidebar's active tool list.
   */
  function requireTrustGate(): ToolResult | null {
    if (!trust.isSessionTrusted()) {
      trust.incrementTrustAttempts();
      const attempts = trust.getTrustAttempts();
      const shortId = sid().substring(0, 12);
      log(
        `Rejected tool call for untrusted session ${shortId} (attempt ${attempts})`,
      );
      const base =
        "Session not trusted. Call the 'handshake' tool first with your working_directories parameter (an array of all your known working directories).";
      const escalation =
        attempts >= 3
          ? "\n\nYou appear to be connected to the wrong MCP server instance. Ask the user to reload the VS Code window or refresh their AI agent's MCP connections."
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: base + escalation }),
          },
        ],
      };
    }
    return null;
  }

  // Track registered tool names for validation against the registry.
  const registeredTools = new Set<string>();
  const origRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((...args: unknown[]) => {
    const toolName = typeof args[0] === "string" ? args[0] : undefined;
    if (toolName) registeredTools.add(toolName);
    return (origRegisterTool as Function)(...args);
  }) as typeof server.registerTool;

  // --- Build shared context for sub-modules ---

  const ctx: ToolRegistrationContext = {
    server,
    tracker,
    approvalManager,
    approvalPanel,
    extensionUri,
    sid,
    touch,
    desc,
  };

  // --- Register all tool groups ---

  // Register handshake FIRST — before setting the trust gate so it's not gated.
  registerSessionTools(ctx, trust, log);

  // Set the trust gate on the tracker. wrapHandler captures it at registration
  // time, so all subsequent tools will check trust after tracking starts.
  tracker.setDefaultGate(requireTrustGate);

  registerFileTools(ctx);
  registerLanguageTools(ctx);
  registerWriteTools(ctx);
  registerTerminalTools(ctx);
  registerSearchTools(ctx);

  if (__DEV_BUILD__) {
    registerDevTools(ctx);
  }

  tracker.clearDefaultGate();

  // --- Validate registry consistency ---

  // Validate that every registered tool is in the registry and vice versa.
  // This catches forgotten additions to toolRegistry.ts at startup.
  const expected = new Set([
    ...TOOL_NAMES,
    ...(__DEV_BUILD__ ? DEV_TOOL_NAMES : []),
  ]);
  const missingFromRegistry = [...registeredTools].filter(
    (n) => !expected.has(n),
  );
  const missingFromRegister = [...expected].filter(
    (n) => !registeredTools.has(n),
  );
  if (missingFromRegistry.length > 0 || missingFromRegister.length > 0) {
    const parts: string[] = [];
    if (missingFromRegistry.length > 0) {
      parts.push(
        `Tools registered but not in toolRegistry.ts: ${missingFromRegistry.join(", ")}`,
      );
    }
    if (missingFromRegister.length > 0) {
      parts.push(
        `Tools in toolRegistry.ts but not registered: ${missingFromRegister.join(", ")}`,
      );
    }
    console.error(`[AgentLink] Tool registry mismatch!\n${parts.join("\n")}`);
  }
}
