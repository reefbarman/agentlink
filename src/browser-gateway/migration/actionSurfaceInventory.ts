import {
  BROWSER_GATEWAY_OWNER_COMMAND_KINDS,
  type BrowserGatewayOwnerCommandKind,
} from "../dataPlane/protocol.js";
import {
  ASK_AGENT_ROUTES,
  type AskAgentRouteHandler,
} from "../helper/helperRouteFamilies.js";

export type BrowserGatewayActionDisposition =
  | "protocol_command"
  | "retained_http"
  | "unsupported";

export interface BrowserGatewayActionInventoryEntry {
  readonly surface: "vscode_gateway" | "ask_agent";
  readonly method: string;
  readonly path: string;
  readonly disposition: BrowserGatewayActionDisposition;
  readonly commandKind?: BrowserGatewayOwnerCommandKind;
  readonly notes: string;
}

const protocolCommand = (
  surface: BrowserGatewayActionInventoryEntry["surface"],
  method: string,
  path: string,
  commandKind: BrowserGatewayOwnerCommandKind,
  notes: string,
): BrowserGatewayActionInventoryEntry => ({
  surface,
  method,
  path,
  disposition: "protocol_command",
  commandKind,
  notes,
});

const retainedHttp = (
  surface: BrowserGatewayActionInventoryEntry["surface"],
  method: string,
  path: string,
  notes: string,
): BrowserGatewayActionInventoryEntry => ({
  surface,
  method,
  path,
  disposition: "retained_http",
  notes,
});

const unsupported = (
  surface: BrowserGatewayActionInventoryEntry["surface"],
  method: string,
  path: string,
  notes: string,
): BrowserGatewayActionInventoryEntry => ({
  surface,
  method,
  path,
  disposition: "unsupported",
  notes,
});

/**
 * Browser-visible routes owned by the per-window VS Code gateway.
 *
 * A source-backed test compares this list with BrowserGatewayServer's public
 * route table. Reads remain HTTP unless authoritative state must flow through
 * the relay. `unsupported` means the endpoint is deliberately unavailable to
 * the browser and must remain so.
 */
export const VSCODE_GATEWAY_ACTION_INVENTORY = [
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/ui-state",
    "Legacy snapshot bootstrap; removed only in Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/instance-status",
    "Instance health metadata remains an HTTP read.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/instances",
    "Legacy instance catalog remains during coexistence.",
  ),
  protocolCommand(
    "vscode_gateway",
    "GET",
    "/api/diff/*",
    "diff.detail",
    "Generation-bound detail lookup replaces this read after detail upload lands.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/events",
    "Legacy snapshot stream retained only as the rollback path.",
  ),
  protocolCommand(
    "vscode_gateway",
    "POST",
    "/api/approval",
    "approval.respond",
    "Approval mutations require operation semantics.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/suggest-regex",
    "Non-authoritative helper computation remains HTTP.",
  ),
  protocolCommand(
    "vscode_gateway",
    "POST",
    "/api/question",
    "question.respond",
    "Question responses require operation semantics and a detail-backed body.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/form-elicitation",
    "Requires a future elicitation command kind before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/url-elicitation",
    "Requires a future elicitation command kind before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/question-progress",
    "Progress drafts remain an HTTP mutation during the bounded coexistence period.",
  ),
  protocolCommand(
    "vscode_gateway",
    "POST",
    "/api/send",
    "session.send",
    "Session send is authoritative and operation-based.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/queue/steer",
    "Requires queue command protocol coverage before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/queue/interject",
    "Requires queue command protocol coverage before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/mode",
    "Requires a session-settings command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/slash-commands",
    "Metadata catalog remains an authenticated HTTP read.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/search-files*",
    "Bounded file search remains an authenticated HTTP read.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/modes",
    "Metadata catalog remains an authenticated HTTP read.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/models",
    "Metadata catalog remains an authenticated HTTP read.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/sessions",
    "History catalog remains an authenticated HTTP read during coexistence.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/model",
    "Requires a session-settings command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/write-approval",
    "Requires a policy command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/command-approval-policy",
    "Requires a policy command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/thinking",
    "Requires a session-settings command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/attach-file",
    "Attachment selection/upload remains HTTP and must produce detail handles.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/project/default",
    "Requires a project-selection command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/session/new",
    "Requires a session-create command before Stage 5.",
  ),
  protocolCommand(
    "vscode_gateway",
    "POST",
    "/api/session/load",
    "session.select",
    "Existing session selection maps to the protocol command.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/session/delete",
    "Requires a session-delete command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/session/rename",
    "Requires a session-rename command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/session/copy-first-prompt",
    "Clipboard payload lookup remains an authenticated HTTP request.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/debug/refresh",
    "Debug data is forbidden from relay state and remains HTTP.",
  ),
  retainedHttp(
    "vscode_gateway",
    "GET",
    "/api/mcp/config",
    "Read-only MCP configuration view remains HTTP.",
  ),
  unsupported(
    "vscode_gateway",
    "POST",
    "/api/mcp/config/server",
    "Browser configuration writes are intentionally unavailable.",
  ),
  unsupported(
    "vscode_gateway",
    "DELETE",
    "/api/mcp/config/server",
    "Browser configuration writes are intentionally unavailable.",
  ),
  unsupported(
    "vscode_gateway",
    "POST",
    "/api/mcp/config/open-raw",
    "Opening local configuration is intentionally unavailable remotely.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/mcp/action",
    "MCP runtime actions require explicit protocol classification before Stage 5.",
  ),
  protocolCommand(
    "vscode_gateway",
    "POST",
    "/api/stop",
    "session.stop",
    "Foreground stop maps to an idempotent operation.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/background/stop",
    "Requires a background-session command before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/background/action",
    "Requires background/fleet command kinds before Stage 5.",
  ),
  retainedHttp(
    "vscode_gateway",
    "POST",
    "/api/background/open-transcript",
    "Maps to bounded history transfer after background transcript protocol support lands.",
  ),
] as const satisfies readonly BrowserGatewayActionInventoryEntry[];

function classifyAskAgentRoute(
  handler: AskAgentRouteHandler,
  method: string,
  path: string,
): BrowserGatewayActionInventoryEntry {
  switch (handler) {
    case "sessionLoad":
      return protocolCommand(
        "ask_agent",
        method,
        path,
        "session.select",
        "Ask Agent session selection maps to the owner command.",
      );
    case "send":
      return protocolCommand(
        "ask_agent",
        method,
        path,
        "session.send",
        "Ask Agent send maps to the owner command after the local adapter lands.",
      );
    case "stop":
      return protocolCommand(
        "ask_agent",
        method,
        path,
        "session.stop",
        "Ask Agent stop maps to the owner command after the local adapter lands.",
      );
    case "approval":
    case "memoryApproval":
      return protocolCommand(
        "ask_agent",
        method,
        path,
        "approval.respond",
        "Approval response maps to the owner command; memory approval needs typed payload coverage.",
      );
    case "question":
      return protocolCommand(
        "ask_agent",
        method,
        path,
        "question.respond",
        "Question response maps to the owner command with a detail-backed body.",
      );
    case "session":
    case "sessions":
    case "sessionNew":
    case "sessionDelete":
    case "sessionRename":
    case "sessionCopyFirstPrompt":
    case "events":
    case "models":
    case "slashCommands":
    case "mcpConfig":
    case "mcpConfigServer":
    case "mcpConfigOpenRaw":
    case "mcpStatus":
    case "mcpRefresh":
    case "questionProgress":
    case "memory":
    case "memoryClear":
    case "log":
    case "model":
    case "memoryProposal":
    case "memoryNudgeDismiss":
    case "readGrants":
    case "readGrantAdd":
    case "readGrantRevoke":
    case "projectHandoffTargets":
    case "projectHandoffPropose":
    case "projectHandoffCancel":
    case "projectHandoffApprove":
    case "thinking":
    case "retry":
      return retainedHttp(
        "ask_agent",
        method,
        path,
        "Retained during the bounded coexistence period; action inventory blocks Stage 5 until classified as a command or permanent read.",
      );
    default:
      return assertNever(handler);
  }
}

export const ASK_AGENT_ACTION_INVENTORY = ASK_AGENT_ROUTES.map((route) =>
  classifyAskAgentRoute(route.handler, route.method, route.path),
);

export const BROWSER_GATEWAY_ACTION_SURFACE_INVENTORY = [
  ...VSCODE_GATEWAY_ACTION_INVENTORY,
  ...ASK_AGENT_ACTION_INVENTORY,
] as const satisfies readonly BrowserGatewayActionInventoryEntry[];

export interface BrowserGatewayProtocolCommandAdoption {
  readonly commandKind: BrowserGatewayOwnerCommandKind;
  readonly status: "routed" | "declared_only";
  readonly routes: readonly string[];
  readonly notes: string;
}

const commandAdoption = {
  "session.select": {
    commandKind: "session.select",
    status: "declared_only",
    routes: ["POST /api/session/load", "POST /api/ask-agent/session/load"],
    notes:
      "Inventory mapping exists; helper command route and production executor are not implemented.",
  },
  "session.send": {
    commandKind: "session.send",
    status: "declared_only",
    routes: ["POST /api/send", "POST /api/ask-agent/send"],
    notes:
      "Inventory mapping exists; detail upload, helper command route, and production executor are not implemented.",
  },
  "session.stop": {
    commandKind: "session.stop",
    status: "declared_only",
    routes: ["POST /api/stop", "POST /api/ask-agent/stop"],
    notes:
      "Inventory mapping exists; helper command route and production executor are not implemented.",
  },
  "approval.respond": {
    commandKind: "approval.respond",
    status: "declared_only",
    routes: ["POST /api/approval", "POST /api/ask-agent/approval"],
    notes:
      "Inventory mapping exists; helper command route and production executor are not implemented.",
  },
  "question.respond": {
    commandKind: "question.respond",
    status: "declared_only",
    routes: ["POST /api/question", "POST /api/ask-agent/question"],
    notes:
      "Inventory mapping exists; response detail upload and production executor are not implemented.",
  },
  "history.load": {
    commandKind: "history.load",
    status: "declared_only",
    routes: ["POST /api/background/open-transcript"],
    notes:
      "The command is parsed but no browser/helper command route or bounded history executor exists.",
  },
  "diff.detail": {
    commandKind: "diff.detail",
    status: "declared_only",
    routes: ["GET /api/diff/*"],
    notes:
      "The command is parsed but detail upload and browser/helper command routing are not implemented.",
  },
} as const satisfies Record<
  BrowserGatewayOwnerCommandKind,
  BrowserGatewayProtocolCommandAdoption
>;

export const BROWSER_GATEWAY_PROTOCOL_COMMAND_ADOPTION =
  BROWSER_GATEWAY_OWNER_COMMAND_KINDS.map((kind) => commandAdoption[kind]);

function assertNever(value: never): never {
  throw new Error(`Unclassified browser gateway action: ${String(value)}`);
}
