export interface HelperRouteMatch<THandler extends string> {
  readonly handler: THandler;
}

interface HelperExactRoute<
  THandler extends string,
> extends HelperRouteMatch<THandler> {
  readonly method: string;
  readonly path: string;
}

export type AskAgentRouteHandler =
  | "session"
  | "sessions"
  | "sessionNew"
  | "sessionLoad"
  | "sessionDelete"
  | "sessionRename"
  | "sessionCopyFirstPrompt"
  | "events"
  | "models"
  | "slashCommands"
  | "mcpConfig"
  | "mcpConfigServer"
  | "mcpConfigOpenRaw"
  | "mcpStatus"
  | "mcpRefresh"
  | "question"
  | "questionProgress"
  | "memory"
  | "memoryClear"
  | "log"
  | "model"
  | "memoryProposal"
  | "memoryNudgeDismiss"
  | "memoryApproval"
  | "approval"
  | "readGrants"
  | "readGrantAdd"
  | "readGrantRevoke"
  | "projectHandoffTargets"
  | "projectHandoffPropose"
  | "projectHandoffCancel"
  | "projectHandoffApprove"
  | "thinking"
  | "send"
  | "retry"
  | "stop";

export const ASK_AGENT_ROUTES = [
  { method: "GET", path: "/api/ask-agent/session", handler: "session" },
  { method: "GET", path: "/api/ask-agent/sessions", handler: "sessions" },
  { method: "POST", path: "/api/ask-agent/session/new", handler: "sessionNew" },
  {
    method: "POST",
    path: "/api/ask-agent/session/load",
    handler: "sessionLoad",
  },
  {
    method: "POST",
    path: "/api/ask-agent/session/delete",
    handler: "sessionDelete",
  },
  {
    method: "POST",
    path: "/api/ask-agent/session/rename",
    handler: "sessionRename",
  },
  {
    method: "POST",
    path: "/api/ask-agent/session/copy-first-prompt",
    handler: "sessionCopyFirstPrompt",
  },
  { method: "GET", path: "/api/ask-agent/events", handler: "events" },
  { method: "GET", path: "/api/ask-agent/models", handler: "models" },
  {
    method: "GET",
    path: "/api/ask-agent/slash-commands",
    handler: "slashCommands",
  },
  { method: "GET", path: "/api/ask-agent/mcp-config", handler: "mcpConfig" },
  {
    method: "POST",
    path: "/api/ask-agent/mcp-config/server",
    handler: "mcpConfigServer",
  },
  {
    method: "DELETE",
    path: "/api/ask-agent/mcp-config/server",
    handler: "mcpConfigServer",
  },
  {
    method: "POST",
    path: "/api/ask-agent/mcp-config/open-raw",
    handler: "mcpConfigOpenRaw",
  },
  { method: "GET", path: "/api/ask-agent/mcp-status", handler: "mcpStatus" },
  { method: "POST", path: "/api/ask-agent/mcp-refresh", handler: "mcpRefresh" },
  { method: "POST", path: "/api/ask-agent/question", handler: "question" },
  {
    method: "POST",
    path: "/api/ask-agent/question-progress",
    handler: "questionProgress",
  },
  { method: "GET", path: "/api/ask-agent/memory", handler: "memory" },
  {
    method: "POST",
    path: "/api/ask-agent/memory/clear",
    handler: "memoryClear",
  },
  { method: "POST", path: "/api/ask-agent/log", handler: "log" },
  { method: "POST", path: "/api/ask-agent/model", handler: "model" },
  {
    method: "POST",
    path: "/api/ask-agent/memory/proposal",
    handler: "memoryProposal",
  },
  {
    method: "POST",
    path: "/api/ask-agent/memory/nudge/dismiss",
    handler: "memoryNudgeDismiss",
  },
  {
    method: "POST",
    path: "/api/ask-agent/memory/approval",
    handler: "memoryApproval",
  },
  { method: "POST", path: "/api/ask-agent/approval", handler: "approval" },
  { method: "GET", path: "/api/ask-agent/read-grants", handler: "readGrants" },
  {
    method: "POST",
    path: "/api/ask-agent/read-grants",
    handler: "readGrantAdd",
  },
  {
    method: "POST",
    path: "/api/ask-agent/read-grants/revoke",
    handler: "readGrantRevoke",
  },
  {
    method: "GET",
    path: "/api/ask-agent/project-handoff/targets",
    handler: "projectHandoffTargets",
  },
  {
    method: "POST",
    path: "/api/ask-agent/project-handoff/propose",
    handler: "projectHandoffPropose",
  },
  {
    method: "POST",
    path: "/api/ask-agent/project-handoff/cancel",
    handler: "projectHandoffCancel",
  },
  {
    method: "POST",
    path: "/api/ask-agent/project-handoff/approve",
    handler: "projectHandoffApprove",
  },
  { method: "POST", path: "/api/ask-agent/thinking", handler: "thinking" },
  { method: "POST", path: "/api/ask-agent/send", handler: "send" },
  { method: "POST", path: "/api/ask-agent/retry", handler: "retry" },
  { method: "POST", path: "/api/ask-agent/stop", handler: "stop" },
] as const satisfies readonly HelperExactRoute<AskAgentRouteHandler>[];

export function matchAskAgentRoute(
  method: string,
  pathname: string,
): HelperRouteMatch<AskAgentRouteHandler> | null {
  return matchExactRoute(ASK_AGENT_ROUTES, method, pathname);
}

export type InternalCoreRouteHandler =
  | "clientLease"
  | "clientRelease"
  | "coreOwnerRegister"
  | "coreOwnerHeartbeat"
  | "coreOwners"
  | "modelCatalog"
  | "modelCredentialGrant"
  | "modelCredentialClear"
  | "modelAuthLease"
  | "modelAuthLeaseValidate"
  | "modelAuthLeaseRevoke";

export const INTERNAL_CORE_ROUTES = [
  { method: "POST", path: "/internal/client/lease", handler: "clientLease" },
  {
    method: "POST",
    path: "/internal/client/release",
    handler: "clientRelease",
  },
  {
    method: "POST",
    path: "/internal/core-owners/register",
    handler: "coreOwnerRegister",
  },
  {
    method: "POST",
    path: "/internal/core-owners/heartbeat",
    handler: "coreOwnerHeartbeat",
  },
  { method: "GET", path: "/internal/core-owners", handler: "coreOwners" },
  { method: "POST", path: "/internal/model-catalog", handler: "modelCatalog" },
  {
    method: "POST",
    path: "/internal/model-auth/credentials",
    handler: "modelCredentialGrant",
  },
  {
    method: "POST",
    path: "/internal/model-auth/credentials/clear",
    handler: "modelCredentialClear",
  },
  {
    method: "POST",
    path: "/internal/model-auth/leases",
    handler: "modelAuthLease",
  },
  {
    method: "POST",
    path: "/internal/model-auth/leases/validate",
    handler: "modelAuthLeaseValidate",
  },
  {
    method: "POST",
    path: "/internal/model-auth/leases/revoke",
    handler: "modelAuthLeaseRevoke",
  },
] as const satisfies readonly HelperExactRoute<InternalCoreRouteHandler>[];

export function matchInternalCoreRoute(
  method: string,
  pathname: string,
): HelperRouteMatch<InternalCoreRouteHandler> | null {
  return matchExactRoute(INTERNAL_CORE_ROUTES, method, pathname);
}

function matchExactRoute<THandler extends string>(
  routes: readonly HelperExactRoute<THandler>[],
  method: string,
  pathname: string,
): HelperRouteMatch<THandler> | null {
  return (
    routes.find(
      (route) => route.method === method && route.path === pathname,
    ) ?? null
  );
}
