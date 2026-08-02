import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { PassThrough, Writable } from "stream";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  buildAgentErrorMessage,
  getAgentErrorActions,
  getAgentErrorCode,
  hasAgentRetryableErrorFlag,
  isAgentAuthErrorMessage,
  isAgentRetryableErrorMessage,
  type AgentRuntimeErrorPresentation,
} from "../../shared/agentErrors.js";

import {
  resolveRegisteredBrowserGatewayDataPlaneModes,
  type BrowserGatewayDataPlaneMode,
} from "../browserGatewayDataPlaneMode.js";
import {
  getBrowserGatewayRegistryPath,
  invalidateBrowserGatewayInstanceHealth,
  isBrowserGatewayInstanceProcessAlive,
  listBrowserGatewayInstances,
  listCheckedBrowserGatewayInstances,
  listHealthyBrowserGatewayInstances,
  listRegisteredBrowserGatewayInstances,
  setBrowserGatewayRegistryLogger,
  type BrowserGatewayInstanceRecord,
} from "../browserGatewayRegistry.js";
import {
  BAKED_BROWSER_GATEWAY_THEME,
  readBrowserGatewayThemeCache,
} from "../browserGatewayThemeCache.js";
import {
  applyBrowserGatewayMcpClientCapabilities,
  buildBrowserGatewayHelperTrustHeaders,
  classifyBrowserGatewayClientOrigin,
  hasBrowserGatewayMcpSecretWrite,
} from "../browserGatewayRequestTrust.js";
import {
  AskAgentController,
  type AskAgentControllerPublication,
  type AskAgentControllerSnapshot,
  type AskAgentControllerState,
  type AskAgentControllerTurn,
} from "./AskAgentController.js";
import {
  AskAgentOwnerAdapter,
  askAgentOwnerCommandCapabilities,
  askAgentOwnerGenerationId,
  type AskAgentOwnerResolvedDetail,
} from "./AskAgentOwnerAdapter.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_FEATURES,
  BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
  type BrowserGatewayClientLeaseRequest,
  type BrowserGatewayClientReleaseRequest,
  type BrowserGatewayCoreOwnerHeartbeatRequest,
  type BrowserGatewayCoreOwnerLeaseRegistration,
  type BrowserGatewayDeviceRevokeRequest,
  type BrowserGatewayModelAuthLeaseRequest,
  type BrowserGatewayModelAuthLeaseRevokeRequest,
  type BrowserGatewayModelAuthLeaseValidationRequest,
  type BrowserGatewayModelCatalogPublishRequest,
  type BrowserGatewayModelCredentialClearRequest,
  type BrowserGatewayModelCredentialClearResponse,
  type BrowserGatewayOpenAiCompatibleRuntimeProfiles,
  type BrowserGatewayPromptProfileResolutions,
  type BrowserGatewayModelCredentialGrantRequest,
  type BrowserGatewayMemoryRuntimeDescriptor,
  type BrowserGatewayDevicesListResponse,
  type BrowserGatewayHelperDiscoveryRecord,
  type BrowserGatewayHelperHealthResponse,
  type BrowserGatewayInstanceStatusSummary,
  type BrowserGatewayMdnsState,
  type BrowserGatewayPairingCancelRequest,
  type BrowserGatewayPairingCreateRequest,
  type BrowserGatewayPairingCreateResponse,
  type BrowserGatewayPairingStatusResponse,
} from "../protocol.js";
import type {
  BrowserGatewayThemeSnapshot,
  ToolResult,
} from "../../shared/types.js";
import {
  getStructuredSecretRedactionMetadata,
  isStructuredConfigPath,
  redactStructuredSecrets,
} from "../../shared/structuredSecretRedaction.js";
import {
  getConfirmationOptions,
  isConfirmationOptions,
} from "../../shared/questionConfirmation.js";
import {
  clearBrowserGatewayHelperDiscovery,
  writeBrowserGatewayHelperDiscovery,
} from "../browserGatewayHelperDiscovery.js";
import { BrowserGatewayModelAuthLeaseStore } from "../browserGatewayModelAuthLeaseStore.js";
import {
  askAgentMediaToDisplayMedia,
  BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE,
  BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
  BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
  BrowserGatewayAskAgentSessionStore,
  type BrowserGatewayAskAgentMediaItem,
  type BrowserGatewayAskAgentPersistedSession,
  type BrowserGatewayAskAgentProjectHandoff,
} from "../browserGatewayAskAgentSessionStore.js";
import {
  BrowserGatewayAskAgentPreferencesStore,
  type BrowserGatewayAskAgentWebPolicyCache,
} from "../browserGatewayAskAgentPreferences.js";
import { BrowserGatewayAskAgentHistoryStore } from "../browserGatewayAskAgentHistory.js";
import type { ChatMessage, Question } from "../../agent/webview/types.js";
import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../approvals/webview/types.js";
import {
  BrowserGatewayModelCredentialCache,
  type BrowserGatewayModelCredentialRecord,
} from "../browserGatewayModelCredentialCache.js";
import {
  BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID,
  normalizeBrowserGatewayModelCredentialProviderId,
} from "../browserGatewayModelProviderIds.js";
import {
  CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS,
  CODEX_IMAGE_GENERATION_MAX_COUNT,
  codexGeneratedImageMetadata,
  codexImageGenerationErrorMetadata,
  generateCodexImages,
  type CodexGeneratedImage,
} from "../../core/model/providers/codex/imageGeneration.js";
import {
  toCoreModelDocumentMediaType,
  toCoreModelImageMediaType,
  type CoreModelContentBlock,
  type CoreModelMessage,
  type CoreModelToolDefinition,
  type CoreModelUsage,
} from "../../core/modelRuntime.js";
import type { OpenAiCompatibleRuntimeProfile } from "../../core/model/providers/openaiCompatible/types.js";
import {
  isCurrentPromptProfileResolution,
  resolvePromptProfile,
  type PromptProfileResolution,
} from "../../core/promptProfile.js";
import { getCodexModelCapabilities } from "../../core/model/providers/codex/models.js";
import { normalizeUserQuestionAttachments } from "../../core/capabilities/sessionControl.js";
import { ANTHROPIC_HOSTED_WEB_CAPABILITIES } from "../../core/model/providers/anthropic/anthropicModels.js";
import {
  normalizeCoreWebAccessSettings,
  resolveCoreWebAccessPolicy,
  type CoreResolvedWebAccessPolicy,
  type CoreWebAccessSettings,
  type CoreWebActivity,
  type CoreWebCitation,
} from "../../core/webAccess.js";
import {
  buildNativeWebDelegationPrompt,
  CORE_NATIVE_WEB_MAX_PAUSE_TURNS,
  CORE_NATIVE_WEB_TOOL_DEFINITIONS,
  mergeNativeWebUsage,
  type CoreNativeWebToolResult,
} from "../../core/nativeWebTools.js";
import { runAgentToolLoop } from "../../core/agentToolLoop.js";
import {
  createNativeToolDisclosureSnapshot,
  discoverNativeTools,
  getDeferredNativeTool,
  type NativeToolDisclosureSnapshot,
} from "../../core/tools/nativeToolDisclosure.js";
import type {
  FinalMessageMarker,
  FinalMessageStatus,
} from "../../shared/finalStatus.js";
import { handleTodoWrite, type TodoToolInput } from "../../agent/todoTool.js";
import { handlePresentImages } from "../../tools/presentImages.js";
import {
  handleManageMemory,
  handleRecallMemory,
} from "../../tools/autonomousMemory.js";
import type {
  ManageMemoryToolInput,
  RecallMemoryToolInput,
} from "../../core/capabilities/memory.js";
import type {
  MemoryArchiveV1,
  MemoryHealthSnapshot,
} from "../../core/memory/contracts.js";
import {
  callNativeToolSchema,
  findNativeToolsSchema,
  manageMemorySchema,
} from "../../shared/toolSchemas.js";
import { MCP_TOOL_BRIDGE_TOOL_NAMES } from "../../shared/mcpToolDefinitions.js";
import {
  ASK_AGENT_NATIVE_DISCLOSURE_BRIDGE_TOOLS,
  ASK_AGENT_SAFE_PROJECTLESS_TOOLS,
  ASK_AGENT_SAFE_PROJECTLESS_TOOL_NAMES,
  BrowserGatewayAskAgentModelClient,
  parseAskAgentDeferredNativeToolInput,
  type BrowserGatewayAskAgentToolCall,
} from "./askAgentModelClient.js";
import {
  BrowserGatewayAskAgentMemoryStore,
  getAskAgentMemorySourceRevision,
  hasAskAgentMemoryPastIntent,
  type BrowserGatewayAskAgentMemorySearchResult,
  type BrowserGatewayAskAgentSessionMemory,
} from "../browserGatewayAskAgentMemory.js";
import type {
  DerivedSessionChunk,
  DerivedSessionSummary,
} from "../../core/session/DerivedSessionRetrievalService.js";
import {
  ASK_AGENT_TRANSCRIPT_EXCERPT_MAX_MESSAGES,
  formatAskAgentMemoryContext,
  formatAskAgentMemoryIndexContext,
  formatAskAgentTranscriptExcerptContext,
  type AskAgentTranscriptExcerpt,
} from "./browserGatewayAskAgentMemoryContext.js";
import {
  BrowserGatewayAskAgentModelSummarizer,
  findAskAgentSummarySecretLikeContent,
  type BrowserGatewayAskAgentSummarizer,
} from "./browserGatewayAskAgentSummarizer.js";
import {
  BrowserGatewayAskAgentMemoryProposalBridge,
  type BrowserGatewayAskAgentMemoryProposalRequest,
} from "./browserGatewayAskAgentMemoryProposal.js";
import { loadAskAgentSlashCommands } from "../../agent/SlashCommandRegistry.js";
import {
  BrowserGatewayCoreOwnerRegistry,
  filterInstancesForVisibleCoreOwners,
} from "../coreOwnerRegistry.js";
import { DeviceStore } from "./deviceStore.js";
import { PairingBroker } from "./pairingBroker.js";
import { MdnsAdvertiser, listLanIpv4UrlsForPort } from "./mdnsAdvertiser.js";
import type {
  CoreCapabilityStatusDto,
  CoreHostKind,
  CoreSessionScopeDto,
} from "../../core/sessionProtocol.js";
import {
  isCoreReasoningEffort,
  type CoreModelCatalogEntry,
  type CoreModelCatalogSnapshot,
} from "../../core/modelCatalog.js";
import { readBoundedBody, readJsonBody } from "../nodeHttpPrimitives.js";
import {
  SseHub,
  type SseClientRemovalReason,
  type SsePublication,
} from "../SseHub.js";
import {
  MAX_MEMORY_NUDGES_PER_SESSION,
  detectMemoryCandidates,
} from "../../shared/memoryCandidates.js";
import {
  getDevelopmentStreamingBaselineMetrics,
  type StreamingBaselineMetrics,
  utf8ByteLength,
} from "../../shared/streamingBaselineMetrics.js";
import type {
  AskAgentRouteHandler,
  BrowserRelayRouteHandler,
  InternalCoreRouteHandler,
  InternalDataPlaneRouteHandler,
  InternalDeviceRouteHandler,
  PairedBrowserRouteHandler,
  PublicHelperRouteHandler,
} from "./helperRouteFamilies.js";
import { HelperHttpRouter } from "./HelperHttpRouter.js";
import { BrowserGatewayDataPlaneRoutes } from "./dataPlaneRoutes.js";
import { BrowserGatewayCommandRoutes } from "./commandRoutes.js";
import { OwnerRelayStore } from "./OwnerRelayStore.js";
import {
  BrowserGatewayRelayRoutes,
  type BrowserRelayAuthIdentity,
} from "./relayRoutes.js";
import { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "../dataPlane/protocol.js";
import {
  HelperLifecycleCoordinator,
  type HelperLivenessReason,
} from "./HelperLifecycleCoordinator.js";
import { BrowserGatewayAutonomousMemoryRuntime } from "./BrowserGatewayAutonomousMemoryRuntime.js";
import { BrowserGatewayDerivedSessionRuntime } from "./BrowserGatewayDerivedSessionRuntime.js";

export interface PreparedAskAgentWebAccess {
  target: BrowserGatewayInstanceRecord | null;
  policy: Readonly<CoreResolvedWebAccessPolicy>;
  tools: readonly CoreModelToolDefinition[];
  parallelSafeMcpToolNames: readonly string[];
  parallelSafeMcpServerNames: readonly string[];
}

const ASK_AGENT_PARALLEL_SAFE_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "read_file",
  "list_files",
  "search_files",
  "recall_memory",
  "find_mcp_tools",
  "list_mcp_resources",
  "read_mcp_resource",
  "list_mcp_prompts",
  "get_mcp_prompt",
]);

function freezeAskAgentValue<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeAskAgentValue(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export interface HelperRuntimeOptions {
  port: number;
  helperVersion: string;
  idleShutdownMs: number;
  extensionRootPath: string;
  /** Override persistent Ask Agent diagnostics log path. Defaults under `~/.agentlink/`. */
  askAgentLogPath?: string;
  /** Maximum graceful helper drain before active streams/sockets are destroyed. */
  shutdownTimeoutMs?: number;
  /** Bind to 0.0.0.0 and advertise via mDNS when true. Default false. */
  lanAccess?: boolean;
  /** mDNS hostname (without `.local`). Default "agentlink". */
  mdnsName?: string;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 60_000;
const DEFAULT_HELPER_VERSION = "dev";
const DEFAULT_MDNS_NAME = "agentlink";
const DEFAULT_ASK_AGENT_LOG_FILE = "browser-gateway-ask-agent.log";
const DEFAULT_CORE_OWNER_HEARTBEAT_TTL_MS = 45_000;
const ASK_AGENT_AUTONOMOUS_MEMORY_MANAGE_SCHEMA = z.object({
  ...manageMemorySchema,
  scope: z.literal("global").optional(),
  nudgeId: z.string().min(1).max(200).optional(),
});
const ASK_AGENT_AUTONOMOUS_MEMORY_QUERY_SCHEMA = z.object({
  query: z.string().max(1_000).optional(),
  kinds: z
    .array(
      z.enum([
        "preference",
        "project_fact",
        "gotcha",
        "decision",
        "workflow_hint",
        "correction",
      ]),
    )
    .max(6)
    .optional(),
  statuses: z
    .array(
      z.enum(["active", "superseded", "contested", "forgotten", "expired"]),
    )
    .max(5)
    .optional(),
  sources: z
    .array(
      z.enum([
        "current_user",
        "repository",
        "foreground_agent",
        "background_agent",
        "import",
      ]),
    )
    .max(5)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const ASK_AGENT_AUTONOMOUS_MEMORY_DETAIL_SCHEMA = z.object({
  recordId: z.string().min(1).max(200),
});
const ASK_AGENT_AUTONOMOUS_MEMORY_CLEAR_SCHEMA = z.object({
  confirm: z.literal(true),
});
const PUBLIC_AUTONOMOUS_MEMORY_REASONS = new Set([
  "no-connected-owner",
  "missing-owner-descriptor",
  "disabled-by-owner",
  "conflicting-store-roots",
  "disabled",
]);

function sanitizeAutonomousMemoryHealth(
  health: MemoryHealthSnapshot,
): MemoryHealthSnapshot {
  const reason =
    health.reason && PUBLIC_AUTONOMOUS_MEMORY_REASONS.has(health.reason)
      ? health.reason
      : undefined;
  return { ...health, reason };
}

function sanitizeAutonomousMemoryResult<
  T extends { health: MemoryHealthSnapshot },
>(result: T): T {
  return { ...result, health: sanitizeAutonomousMemoryHealth(result.health) };
}

const ASK_AGENT_AUTONOMOUS_MEMORY_IMPORT_SCHEMA = z.object({
  archive: z.object({
    schema: z.literal("agentlink-memory"),
    version: z.literal(1),
    archiveId: z.string().min(1).max(200),
    exportedAt: z.string().min(1).max(100),
    scope: z.object({
      kind: z.enum(["global", "workspace"]),
      id: z.string().min(1).max(500),
    }),
    records: z.array(z.unknown()).max(10_000),
    warning: z.string().min(1).max(2_000),
  }),
});
const ASK_AGENT_LOG_FIELD_LIMIT = 32;
const ASK_AGENT_MEMORY_SUMMARY_DEBOUNCE_MS = 750;
const ASK_AGENT_MEMORY_DISCLOSURE_SOURCE_LIMIT = 5;
const ASK_AGENT_MEMORY_DISCLOSURE_SUMMARY_SOURCE_LIMIT = 3;
const ASK_AGENT_MEMORY_DISCLOSURE_TRANSCRIPT_SOURCE_LIMIT = 2;
const ASK_AGENT_MEMORY_INDEX_SESSION_LIMIT = 12;
const CORE_HOST_KINDS = new Set<CoreHostKind>([
  "vscode",
  "browser-gateway",
  "cli",
  "desktop",
  "server",
  "test",
]);
const AGENTLINK_ICON_PATH = "/agentlink-icon.png";
const AGENTLINK_ICON_SVG_PATH = "/agentlink-icon.svg";
const AGENTLINK_ICON_SIZES = "256x256";

function logHelper(message: string): void {
  process.stderr.write(`[browser-gateway-helper] ${message}\n`);
}

function getDefaultAskAgentLogPath(): string {
  return path.join(os.homedir(), ".agentlink", DEFAULT_ASK_AGENT_LOG_FILE);
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid_port:${value ?? ""}`);
  }
  return parsed;
}

function parseIdleShutdownMs(value: string | undefined): number {
  if (!value) return DEFAULT_IDLE_SHUTDOWN_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_IDLE_SHUTDOWN_MS;
  }
  return Math.floor(parsed);
}

function parseBoolFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function parseArgs(argv: string[]): HelperRuntimeOptions {
  const byKey = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    if (!key) continue;
    byKey.set(key, rest.join("="));
  }

  const port = parsePort(
    byKey.get("port") ?? process.env.AGENTLINK_BROWSER_GATEWAY_PORT,
  );
  const helperVersion =
    byKey.get("helperVersion") ??
    process.env.AGENTLINK_BROWSER_GATEWAY_HELPER_VERSION ??
    DEFAULT_HELPER_VERSION;
  const idleShutdownMs = parseIdleShutdownMs(
    byKey.get("idleShutdownMs") ??
      process.env.AGENTLINK_BROWSER_GATEWAY_IDLE_SHUTDOWN_MS,
  );
  const extensionRootPath =
    byKey.get("extensionRootPath") ??
    process.env.AGENTLINK_EXTENSION_ROOT_PATH ??
    process.cwd();
  const lanAccess = parseBoolFlag(
    byKey.get("lanAccess") ?? process.env.AGENTLINK_BROWSER_GATEWAY_LAN_ACCESS,
  );
  const mdnsName = (
    byKey.get("mdnsName") ??
    process.env.AGENTLINK_BROWSER_GATEWAY_MDNS_NAME ??
    DEFAULT_MDNS_NAME
  ).trim();
  const askAgentLogPath = (
    byKey.get("askAgentLogPath") ??
    process.env.AGENTLINK_BROWSER_GATEWAY_ASK_AGENT_LOG_PATH ??
    getDefaultAskAgentLogPath()
  ).trim();

  return {
    port,
    helperVersion,
    idleShutdownMs,
    extensionRootPath,
    askAgentLogPath: askAgentLogPath || getDefaultAskAgentLogPath(),
    lanAccess,
    mdnsName: mdnsName || DEFAULT_MDNS_NAME,
  };
}

async function readFormBody(
  req: http.IncomingMessage,
): Promise<Record<string, string>> {
  const raw = (await readBoundedBody(req)).toString("utf-8");
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

type InProcessAskAgentResponse = {
  readonly status: number;
  readonly payload: unknown;
};

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: http.OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function assertSuccessfulAskAgentCommand(
  result: InProcessAskAgentResponse,
): void {
  if (result.status >= 200 && result.status < 300) return;
  const error =
    result.payload && typeof result.payload === "object"
      ? (result.payload as { error?: unknown }).error
      : undefined;
  throw new Error(
    typeof error === "string" ? error : "ask_agent_command_failed",
  );
}

// This bridge is intentionally limited to handlers that produce one terminal JSON
// response. It is not compatible with streaming handlers or header-dependent logic.
async function invokeJsonHandlerInProcess(
  payload: unknown,
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>,
): Promise<InProcessAskAgentResponse> {
  const body = Buffer.from(JSON.stringify(payload));
  const request = new PassThrough() as PassThrough & http.IncomingMessage;
  request.headers = { "content-length": String(body.byteLength) };
  request.end(body);
  let status = 200;
  const chunks: Buffer[] = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  }) as Writable & http.ServerResponse;
  response.writeHead = ((statusCode: number) => {
    status = statusCode;
    return response;
  }) as http.ServerResponse["writeHead"];
  await handler(request, response);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) throw new Error("ask_agent_command_empty_response");
  return {
    status,
    payload: JSON.parse(raw) as unknown,
  };
}

const BROWSER_SESSION_COOKIE_NAME = "agentlink_bg_session";

type BrowserGatewayInstanceListItem = Omit<
  BrowserGatewayInstanceRecord,
  "authToken"
> & {
  status?: BrowserGatewayInstanceStatusSummary;
};

type AskAgentProjectHandoffTarget = {
  instanceId: string;
  workspaceName: string;
  workspacePath: string;
  url: string;
  status?: BrowserGatewayInstanceStatusSummary;
};

function writeHtml(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssValueEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "")
    .replace(/}/g, "")
    .replace(/<\//g, "<\\/");
}

function renderThemeStyleTag(theme: BrowserGatewayThemeSnapshot): string {
  const declarations = Object.entries(theme.cssVariables)
    .filter(
      ([key, value]) =>
        /^--vscode-[A-Za-z0-9_.-]+$/.test(key) &&
        value.trim() &&
        !/url\s*\(/i.test(value),
    )
    .map(([key, value]) => `    ${key}: ${cssValueEscape(value.trim())};`);
  const colorScheme =
    theme.colorScheme === "light" || theme.colorScheme === "hc-light"
      ? "light"
      : "dark";
  declarations.unshift(`    color-scheme: ${colorScheme};`);
  return `<style id="agentlink-initial-theme">\n  :root {\n${declarations.join("\n")}\n  }\n</style>`;
}

function isLoopbackAddress(addr: string | undefined): boolean {
  return classifyBrowserGatewayClientOrigin(addr) === "loopback";
}

function parseAskAgentMediaItems(
  value: unknown,
): BrowserGatewayAskAgentMediaItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as {
        name?: unknown;
        mimeType?: unknown;
        base64?: unknown;
      };
      const name =
        typeof candidate.name === "string" ? candidate.name.trim() : "";
      const mimeType =
        typeof candidate.mimeType === "string" ? candidate.mimeType.trim() : "";
      const base64 =
        typeof candidate.base64 === "string" ? candidate.base64.trim() : "";
      if (!name || !mimeType || !base64) return null;
      return { name, mimeType, base64 };
    })
    .filter((item): item is BrowserGatewayAskAgentMediaItem => item !== null);
}

const ASK_AGENT_GENERIC_MODEL_ERROR =
  "I tried to call the model, but the request failed before a response was available. Please try again.";
const ASK_AGENT_AUTH_MODEL_ERROR =
  "I tried to call the model, but the cached browser-gateway credentials were rejected or expired. Open a VS Code AgentLink window to refresh them.";
const ASK_AGENT_STOPPED_MODEL_ERROR = "Response stopped.";
const ASK_AGENT_EMPTY_MODEL_ERROR =
  "The model finished without returning a response. Please try again.";

function getSanitizedModelErrorFields(
  error: unknown,
): Record<string, string | number | boolean | null> {
  if (!error || typeof error !== "object") {
    return { errorType: typeof error, errorMessage: String(error) };
  }

  const candidate = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    code?: unknown;
    type?: unknown;
    error?: unknown;
  };
  const fields: Record<string, string | number | boolean | null> = {
    errorType: typeof candidate.name === "string" ? candidate.name : "Error",
  };
  if (typeof candidate.message === "string") {
    fields.errorMessage = candidate.message;
  }
  if (typeof candidate.status === "number") {
    fields.errorStatus = candidate.status;
  }
  if (typeof candidate.code === "string") {
    fields.errorCode = candidate.code;
  }
  if (typeof candidate.type === "string") {
    fields.errorApiType = candidate.type;
  }

  if (candidate.error && typeof candidate.error === "object") {
    const apiError = candidate.error as {
      message?: unknown;
      code?: unknown;
      type?: unknown;
    };
    if (typeof apiError.message === "string") {
      fields.errorApiMessage = apiError.message;
    }
    if (typeof apiError.code === "string") {
      fields.errorApiCode = apiError.code;
    }
    if (typeof apiError.type === "string") {
      fields.errorApiErrorType = apiError.type;
    }
  }

  return fields;
}

function getAskAgentModelErrorText(error: unknown): string {
  const message = buildAgentErrorMessage(error).trim();
  return message || ASK_AGENT_GENERIC_MODEL_ERROR;
}

function buildAskAgentModelErrorPresentation(params: {
  error: unknown;
  authFailed: boolean;
  stopped: boolean;
}): AgentRuntimeErrorPresentation {
  if (params.stopped) {
    return {
      message: ASK_AGENT_STOPPED_MODEL_ERROR,
      retryable: false,
      code: "model_stopped",
    };
  }
  if (params.authFailed) {
    return {
      message: ASK_AGENT_AUTH_MODEL_ERROR,
      retryable: true,
      code: "model_auth_failed",
      actions: { signIn: true },
    };
  }

  const message = getAskAgentModelErrorText(params.error);
  const retryable =
    isAgentAuthErrorMessage(message) ||
    isAgentRetryableErrorMessage(message) ||
    hasAgentRetryableErrorFlag(params.error);
  const actions = getAgentErrorActions(params.error);
  const code = getAgentErrorCode(params.error) ?? "model_error";
  return {
    message,
    retryable,
    code,
    ...(actions ? { actions } : {}),
  };
}

type AuthResult =
  | { kind: "bootstrap" }
  | { kind: "device"; deviceId: string; deviceLabel: string }
  | { kind: "none" };

type AskAgentMemoryDisclosure = NonNullable<ChatMessage["memoryDisclosure"]>;

type AskAgentMemoryContextResult = {
  context: string;
  disclosure: AskAgentMemoryDisclosure;
};

type AskAgentDerivedMemoryStatus = {
  sessionSummaryCount: number;
  chunkSummaryCount: number;
  totalSummaryCount: number;
  lastUpdatedAt: number | null;
  recentSessions: Array<{
    sessionId: string;
    title: string;
    messageCount: number;
    updatedAt: number;
  }>;
};

type AskAgentToolLoopOutcome =
  | "model_success"
  | "model_empty"
  | "model_question"
  | "model_final";

type AskAgentToolLoopResult = {
  outcome: AskAgentToolLoopOutcome;
  assistantText: string;
};

type AskAgentToolExecutionResult = {
  content: string;
  modelContent?: string | CoreModelContentBlock[];
  resultImages?: Array<{ mimeType: string; data: string }>;
  stop: boolean;
  outcome?: AskAgentToolLoopOutcome;
  toolMessage?: CoreModelMessage;
  modelResult?: string;
};

type ResolvedAskAgentToolCall = {
  providerCall: BrowserGatewayAskAgentToolCall;
  canonicalCall: BrowserGatewayAskAgentToolCall;
  resolutionError?: {
    message: string;
    status: string;
    issues?: readonly z.core.$ZodIssue[];
  };
};

function askAgentMediaFromToolResult(result: ToolResult | undefined): {
  content: string;
  modelContent: string | CoreModelContentBlock[];
  resultImages: Array<{ mimeType: string; data: string }>;
} {
  if (!result) {
    return { content: "", modelContent: "", resultImages: [] };
  }
  const text = result.content
    .filter(
      (
        item,
      ): item is Extract<ToolResult["content"][number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
  const modelBlocks: CoreModelContentBlock[] = text
    ? [{ type: "text", text }]
    : [];
  const resultImages: Array<{ mimeType: string; data: string }> = [];
  for (const item of result.content) {
    if (item.type !== "image") continue;
    const mediaType = toCoreModelImageMediaType(item.mimeType);
    if (!mediaType) continue;
    modelBlocks.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: item.data },
    });
    resultImages.push({ mimeType: mediaType, data: item.data });
  }
  return {
    content: text,
    modelContent: modelBlocks.length > 0 ? modelBlocks : text,
    resultImages,
  };
}

type AskAgentSessionResponse = { readonly ok: true } & AskAgentControllerState;

type BrowserGatewayPrivateModelCatalogSnapshot = CoreModelCatalogSnapshot & {
  publishedByOwnerGenerationId: string;
  openAiCompatibleRuntimeProfiles: BrowserGatewayOpenAiCompatibleRuntimeProfiles;
  promptProfileResolutions: BrowserGatewayPromptProfileResolutions;
};

type AskAgentModelExecutionContext = {
  modelOwnerId: string;
  ownerId: string;
  ownerGenerationId: string;
  providerId: string;
  model: string;
  promptProfile: Readonly<PromptProfileResolution>;
  credential?: BrowserGatewayModelCredentialRecord;
  openAiCompatibleRuntimeProfile?: OpenAiCompatibleRuntimeProfile;
};

export class BrowserGatewayHelper {
  private readonly startedAt = new Date();
  private readonly startedAtMs = this.startedAt.getTime();
  private readonly browserBootstrapToken = randomUUID();
  private readonly clientSharedSecret = randomUUID();
  private readonly helperGenerationId = randomUUID();
  private readonly activeClientLeases = new Map<string, number>();
  private readonly coreOwnerRegistry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: DEFAULT_CORE_OWNER_HEARTBEAT_TTL_MS,
  });
  private readonly modelAuthLeaseStore = new BrowserGatewayModelAuthLeaseStore({
    helperGenerationId: this.helperGenerationId,
    ownerRegistry: this.coreOwnerRegistry,
  });
  private readonly modelCredentialCache =
    new BrowserGatewayModelCredentialCache();
  private readonly modelCatalogSnapshots = new Map<
    string,
    BrowserGatewayPrivateModelCatalogSnapshot
  >();
  private askAgentModelOwnerId: string | undefined;
  private latestModelCatalogOwnerId: string | undefined;
  private readonly askAgentController: AskAgentController;
  private readonly askAgentOwnerAdapter: AskAgentOwnerAdapter;
  private readonly askAgentSseHub: SseHub<AskAgentControllerSnapshot>;
  private readonly streamingMetrics: StreamingBaselineMetrics;
  private readonly askAgentModelClient: Pick<
    BrowserGatewayAskAgentModelClient,
    "complete"
  > &
    Partial<
      Pick<
        BrowserGatewayAskAgentModelClient,
        "completeWithToolCalls" | "executeNativeWebTool"
      >
    >;

  private readonly askAgentLogPath: string;
  private readonly askAgentPreferencesStore: BrowserGatewayAskAgentPreferencesStore;
  private readonly askAgentHistoryStore: BrowserGatewayAskAgentHistoryStore;
  /** Test compatibility seam; production uses askAgentDerivedSessionRuntime. */
  private readonly askAgentMemoryStore:
    | BrowserGatewayAskAgentMemoryStore
    | undefined;
  private readonly askAgentDerivedSessionRuntime: BrowserGatewayDerivedSessionRuntime;
  private readonly askAgentAutonomousMemoryRuntime: BrowserGatewayAutonomousMemoryRuntime;
  private readonly askAgentMemoryRuntimeByOwner = new Map<
    string,
    BrowserGatewayMemoryRuntimeDescriptor
  >();
  private readonly askAgentMemoryProposalBridge: BrowserGatewayAskAgentMemoryProposalBridge;
  private readonly askAgentSummarizer: BrowserGatewayAskAgentSummarizer;
  private readonly askAgentMemorySummaryDebounceMs: number;
  private readonly askAgentMemorySummaryTimers = new Map<
    string,
    NodeJS.Timeout
  >();
  private readonly askAgentMemorySummaryControllers = new Map<
    string,
    AbortController
  >();

  private readonly askAgentMemorySecretSkippedRevisions = new Map<
    string,
    string
  >();
  private readonly httpRouter: HelperHttpRouter<AuthResult>;
  private readonly lifecycle: HelperLifecycleCoordinator;
  private readonly relayStore: OwnerRelayStore;
  private readonly relayRoutes: BrowserGatewayRelayRoutes;
  private readonly commandRoutes: BrowserGatewayCommandRoutes;
  private readonly dataPlaneRoutes: BrowserGatewayDataPlaneRoutes;
  private readonly deviceStore: DeviceStore;
  private readonly pairingBroker: PairingBroker;
  private mdnsAdvertiser: MdnsAdvertiser | null = null;
  private mdnsState: BrowserGatewayMdnsState = { enabled: false };
  private idleCheckTimer: NodeJS.Timeout | undefined;
  private discoveryHeartbeatTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;
  private stopPromise: Promise<void> | undefined;
  private lastLeaseActivityAtMs = Date.now();
  private dataPlaneModeFallbackFingerprint: string | undefined;
  private releaseAskAgentTurnLiveness: (() => void) | undefined;
  private readonly bindHost: string;

  private get askAgentSessionStore(): BrowserGatewayAskAgentSessionStore {
    return this.askAgentController.sessionStore;
  }

  constructor(
    private readonly options: HelperRuntimeOptions,
    private readonly server: http.Server,
    injectables: {
      deviceStore?: DeviceStore;
      pairingBroker?: PairingBroker;
      mdnsAdvertiser?: MdnsAdvertiser;
      askAgentModelClient?: Pick<
        BrowserGatewayAskAgentModelClient,
        "complete"
      > &
        Partial<
          Pick<
            BrowserGatewayAskAgentModelClient,
            "completeWithToolCalls" | "executeNativeWebTool"
          >
        >;
      askAgentSummarizer?: BrowserGatewayAskAgentSummarizer;
      askAgentMemoryStore?: BrowserGatewayAskAgentMemoryStore;
      askAgentDerivedSessionRuntime?: BrowserGatewayDerivedSessionRuntime;
      askAgentAutonomousMemoryRuntime?: BrowserGatewayAutonomousMemoryRuntime;
      askAgentMemorySummaryDebounceMs?: number;
      askAgentPreferencesStore?: BrowserGatewayAskAgentPreferencesStore;
      askAgentHistoryStore?: BrowserGatewayAskAgentHistoryStore;
      streamingMetrics?: StreamingBaselineMetrics;
      beforeAskAgentSnapshotPublish?: (
        publication: AskAgentControllerPublication,
      ) => void | Promise<void>;
    } = {},
  ) {
    this.lifecycle = new HelperLifecycleCoordinator({
      server,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      onLivenessChanged: (reasons) => this.handleLivenessChanged(reasons),
    });
    this.relayStore = new OwnerRelayStore({
      helperGenerationId: this.helperGenerationId,
    });
    this.relayRoutes = new BrowserGatewayRelayRoutes({
      helperGenerationId: this.helperGenerationId,
      ownerRegistry: this.coreOwnerRegistry,
      store: this.relayStore,
      lifecycle: this.lifecycle,
      isAllowedHost: (host) => this.isAllowedRelayHost(host),
      onSubscriberCountChanged: (
        ownerId,
        ownerGenerationId,
        subscriberCount,
      ) => {
        if (
          ownerId === BROWSER_GATEWAY_ASK_AGENT_OWNER_ID &&
          ownerGenerationId === this.askAgentOwnerAdapter.ownerGenerationId
        ) {
          try {
            this.askAgentOwnerAdapter.setDemanded(subscriberCount > 0);
          } catch (error) {
            logHelper(`ask-agent relay demand update failed: ${String(error)}`);
          }
          return;
        }
        try {
          this.dataPlaneRoutes.publishControl({
            protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
            helperGenerationId: this.helperGenerationId,
            ownerId,
            ownerGenerationId,
            kind: "demand.changed",
            emittedAt: Date.now(),
            payload: { subscriberCount },
          });
        } catch {
          // Owner expiry can race browser stream cleanup.
        }
      },
      onCheckpointRequested: (ownerId, ownerGenerationId, latestSequence) => {
        if (
          ownerId === BROWSER_GATEWAY_ASK_AGENT_OWNER_ID &&
          ownerGenerationId === this.askAgentOwnerAdapter.ownerGenerationId
        ) {
          try {
            this.askAgentOwnerAdapter.publishRecoveryCheckpoint();
          } catch (error) {
            logHelper(
              `ask-agent relay checkpoint request failed: ${String(error)}`,
            );
          }
          return;
        }
        try {
          this.dataPlaneRoutes.publishControl({
            protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
            helperGenerationId: this.helperGenerationId,
            ownerId,
            ownerGenerationId,
            kind: "checkpoint.requested",
            emittedAt: Date.now(),
            payload: { reason: "checkpoint_required", latestSequence },
          });
        } catch {
          // Owner expiry can race relay replay/compaction.
        }
      },
      onCommand: (context, value) => this.commandRoutes.handle(context, value),
      onOperationStatus: (context, operationId) =>
        this.commandRoutes.lookupOperation(context, operationId),
      onConnectionClosed: (browserConnectionId) =>
        this.commandRoutes.closeBrowserConnection(browserConnectionId),
    });
    this.commandRoutes = new BrowserGatewayCommandRoutes({
      helperGenerationId: this.helperGenerationId,
      ownerRegistry: this.coreOwnerRegistry,
      publishCommand: (command) =>
        command.ownerId === BROWSER_GATEWAY_ASK_AGENT_OWNER_ID
          ? this.askAgentOwnerAdapter.publishCommand(command)
          : this.dataPlaneRoutes.publishCommand(command),
      cancelCommand: (command) =>
        command.ownerId === BROWSER_GATEWAY_ASK_AGENT_OWNER_ID
          ? this.askAgentOwnerAdapter.cancelCommand(command)
          : this.dataPlaneRoutes.cancelCommand(command),
      emitOperation: (
        browserConnectionId,
        ownerId,
        ownerGenerationId,
        operation,
      ) => {
        this.relayRoutes.emitOperation(
          browserConnectionId,
          ownerId,
          ownerGenerationId,
          operation,
        );
      },
    });
    this.dataPlaneRoutes = new BrowserGatewayDataPlaneRoutes({
      helperGenerationId: this.helperGenerationId,
      ownerRegistry: this.coreOwnerRegistry,
      lifecycle: this.lifecycle,
      onPublication: (batch) => {
        this.relayStore.ingestPublication(batch);
      },
      onAcknowledgement: (acknowledgement) =>
        this.commandRoutes.onAcknowledgement(acknowledgement),
      onDetail: (handle, content) => {
        this.relayStore.putDetail(handle, content);
      },
    });
    this.streamingMetrics =
      injectables.streamingMetrics ??
      getDevelopmentStreamingBaselineMetrics("ask-agent-helper", __DEV_BUILD__);
    this.askAgentSseHub = new SseHub({
      serialize: (snapshot: AskAgentControllerSnapshot) =>
        this.serializeAskAgentSnapshot(snapshot),
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      flushHeaders: false,
      onClientCountChanged: (clientCount) =>
        this.recordAskAgentClientCount(clientCount),
      onClientRemoved: (reason) => this.recordAskAgentClientRemoval(reason),
      onFirstDelivery: (sample) => this.recordAskAgentFirstDelivery(sample),
    });
    this.askAgentController = new AskAgentController({
      ownerRegistry: this.coreOwnerRegistry,
      ownerGenerationId: askAgentOwnerGenerationId(this.helperGenerationId),
      additionalOwnerCapabilities: askAgentOwnerCommandCapabilities(),
      coalesceMs: 20,
      byteLength: utf8ByteLength,
      publish: async (publication) => {
        await injectables.beforeAskAgentSnapshotPublish?.(publication);
        this.broadcastAskAgentPublication(publication);
        this.askAgentOwnerAdapter.publishControllerPublication(publication);
      },
      serialize: (snapshot) => this.serializeAskAgentSnapshot(snapshot),
      onSnapshotBuilt: (snapshot, durationMs) =>
        this.recordAskAgentSnapshotBuild(snapshot, durationMs),
      memoryNudgeLimit: MAX_MEMORY_NUDGES_PER_SESSION,
      createMemoryNudgeId: () => `ask-agent-memory-nudge-${randomUUID()}`,
      onMemoryNudgeDetected: (nudge) => {
        this.logAskAgentEvent("ask-agent.memory.nudge.detected", {
          ok: true,
          sessionId: nudge.sessionId,
          kind: nudge.kind,
        });
      },
      onCompletedTurn: (sessionId) =>
        this.scheduleAskAgentMemorySummary(sessionId),
      onActiveTurnChanged: (active) => this.handleAskAgentTurnChanged(active),
    });
    this.askAgentOwnerAdapter = new AskAgentOwnerAdapter({
      helperGenerationId: this.helperGenerationId,
      ownerRegistry: this.coreOwnerRegistry,
      ingestPublication: async (batch) => {
        await this.dataPlaneRoutes.ingestPublication(batch);
      },
      putDetail: (handle, content) =>
        this.relayStore.putDetail(handle, content),
      getDetail: (params) => this.relayStore.getDetail(params),
      acknowledge: (acknowledgement) =>
        this.commandRoutes.onAcknowledgement(acknowledgement),
      onPublicationError: (error) =>
        logHelper(`ask-agent relay publication failed: ${String(error)}`),
      executor: {
        selectSession: (sessionId) =>
          this.executeAskAgentSelectSessionCommand(sessionId),
        send: (params) => this.executeAskAgentSendCommand(params),
        stopSession: (sessionId) => this.executeAskAgentStopCommand(sessionId),
        respondToApproval: (params) =>
          this.executeAskAgentApprovalCommand(params),
        respondToQuestion: (params) =>
          this.executeAskAgentQuestionCommand(params),
        loadHistory: (params) => this.loadAskAgentHistoryCommand(params),
      },
    });
    this.deviceStore = injectables.deviceStore ?? new DeviceStore();
    this.pairingBroker = injectables.pairingBroker ?? new PairingBroker();
    this.mdnsAdvertiser = injectables.mdnsAdvertiser ?? null;
    this.askAgentPreferencesStore =
      injectables.askAgentPreferencesStore ??
      new BrowserGatewayAskAgentPreferencesStore();
    this.askAgentHistoryStore =
      injectables.askAgentHistoryStore ??
      new BrowserGatewayAskAgentHistoryStore();

    this.askAgentModelClient =
      injectables.askAgentModelClient ??
      new BrowserGatewayAskAgentModelClient({
        sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
      });
    this.askAgentMemoryStore = injectables.askAgentMemoryStore;
    this.askAgentDerivedSessionRuntime =
      injectables.askAgentDerivedSessionRuntime ??
      new BrowserGatewayDerivedSessionRuntime();
    this.askAgentAutonomousMemoryRuntime =
      injectables.askAgentAutonomousMemoryRuntime ??
      new BrowserGatewayAutonomousMemoryRuntime();
    this.askAgentMemoryProposalBridge =
      new BrowserGatewayAskAgentMemoryProposalBridge();
    this.askAgentSummarizer =
      injectables.askAgentSummarizer ??
      new BrowserGatewayAskAgentModelSummarizer({
        sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
      });
    this.askAgentMemorySummaryDebounceMs =
      injectables.askAgentMemorySummaryDebounceMs ??
      ASK_AGENT_MEMORY_SUMMARY_DEBOUNCE_MS;
    this.askAgentLogPath =
      options.askAgentLogPath ?? getDefaultAskAgentLogPath();
    this.bindHost = options.lanAccess ? "0.0.0.0" : "127.0.0.1";
    this.httpRouter = new HelperHttpRouter(options.port, {
      isInternalAuthorized: (req) => this.isInternalClientAuthorized(req),
      isOwnerPlaneLoopback: (req) =>
        classifyBrowserGatewayClientOrigin(req.socket.remoteAddress) ===
        "loopback",
      authenticate: async (req) => {
        const auth = await this.authenticateRequest(req);
        return auth.kind === "none" ? null : auth;
      },
      recordAuthenticatedActivity: (auth) => this.recordDeviceActivity(auth),
      handleAskAgent: (handler, req, res) =>
        this.handleAskAgentRoute(handler, req, res),
      handleInternalCore: (handler, req, res) =>
        this.handleInternalCoreRoute(handler, req, res),
      handleInternalDataPlane: (handler, req, res, requestUrl) =>
        this.handleInternalDataPlaneRoute(handler, req, res, requestUrl),
      handleInternalDevice: (handler, req, res, requestUrl) =>
        this.handleInternalDeviceRoute(handler, req, res, requestUrl),
      handlePairedBrowser: (handler, req, res) =>
        this.handlePairedBrowserRoute(handler, req, res),
      handleBrowserRelay: (handler, auth, req, res, requestUrl) =>
        this.handleBrowserRelayRoute(handler, auth, req, res, requestUrl),
      handlePublic: (handler, pathname, req, res, requestUrl) =>
        this.handlePublicRoute(handler, pathname, req, res, requestUrl),
      handleInstances: (requestUrl, res) =>
        this.handleInstancesRequest(requestUrl, res),
      handleProxy: (req, res, requestUrl) =>
        this.handleProxyRequest(req, res, requestUrl),
      handleShutdown: (res) => {
        writeJson(res, 202, { ok: true });
        setImmediate(() => {
          void this.stop("admin_shutdown");
        });
      },
      writeJson,
    });
    setBrowserGatewayRegistryLogger(logHelper);
    logHelper(
      `constructed pid=${process.pid} port=${options.port} bindHost=${this.bindHost} registry=${getBrowserGatewayRegistryPath()} askAgentLog=${JSON.stringify(this.askAgentLogPath)} extensionRoot=${JSON.stringify(options.extensionRootPath)}`,
    );
    this.logAskAgentEvent("helper.constructed", {
      port: options.port,
      bindHost: this.bindHost,
      helperGenerationId: this.helperGenerationId,
      lanAccess: Boolean(options.lanAccess),
    });
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 0;
    this.server.headersTimeout = 0;
  }

  /** Exposed for tests — the shared secret used for `/internal/*` auth. */
  getClientSharedSecret(): string {
    return this.clientSharedSecret;
  }

  /** Exposed for lifecycle integration tests. */
  getLifecycleStateForTest(): {
    acceptedSocketCount: number;
    activeStreamCount: number;
    livenessReasons: readonly HelperLivenessReason[];
  } {
    return {
      acceptedSocketCount: this.lifecycle.acceptedSocketCount,
      activeStreamCount: this.lifecycle.activeStreamCount,
      livenessReasons: this.lifecycle.getLivenessReasons(),
    };
  }

  /** Exposed for deterministic idle-liveness integration tests. */
  isIdleShutdownEligibleForTest(nowMs: number): boolean {
    return this.shouldShutdownForIdle(nowMs);
  }

  async start(): Promise<void> {
    const [preferences, history] = await Promise.all([
      this.askAgentPreferencesStore.read(),
      this.askAgentHistoryStore.read(),
    ]);
    this.restoreState(preferences, history);
    const askAgentState = await this.buildAskAgentResponse();
    this.askAgentOwnerAdapter.initialize(askAgentState.snapshot);
    this.dataPlaneRoutes.ownerRegistered(
      BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      this.askAgentOwnerAdapter.ownerGenerationId,
    );
    this.relayStore.ownerRegistered(
      BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      this.askAgentOwnerAdapter.ownerGenerationId,
    );
    this.relayRoutes.ownerRegistered(
      BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      this.askAgentOwnerAdapter.ownerGenerationId,
    );
    this.logAskAgentEvent("helper.starting", {
      port: this.options.port,
      bindHost: this.bindHost,
      helperGenerationId: this.helperGenerationId,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.bindHost);
    });

    if (this.options.lanAccess) {
      await this.startMdnsAdvertiser();
    }

    await this.writeDiscovery();
    this.discoveryHeartbeatTimer = setInterval(() => {
      void this.writeDiscovery().catch((error) => {
        logHelper(`discovery heartbeat failed: ${String(error)}`);
      });
    }, 5_000);

    this.lastLeaseActivityAtMs = Date.now();
    this.idleCheckTimer = setInterval(() => {
      void this.maybeShutdownForIdle();
    }, 1_000);

    this.logAskAgentEvent("helper.ready", {
      port: this.options.port,
      bindHost: this.bindHost,
      helperGenerationId: this.helperGenerationId,
      lanAccess: Boolean(this.options.lanAccess),
      mdnsEnabled: Boolean(this.mdnsState.enabled),
    });

    process.stdout.write(
      JSON.stringify({
        type: "helper_ready",
        port: this.options.port,
        protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
        startedAt: this.startedAt.toISOString(),
        lanAccess: Boolean(this.options.lanAccess),
        mdns: this.mdnsState,
      }) + "\n",
    );
  }

  stop(reason = "shutdown"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.shuttingDown = true;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  private async performStop(reason: string): Promise<void> {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = undefined;
    }
    if (this.discoveryHeartbeatTimer) {
      clearInterval(this.discoveryHeartbeatTimer);
      this.discoveryHeartbeatTimer = undefined;
    }
    for (const timer of this.askAgentMemorySummaryTimers.values()) {
      clearTimeout(timer);
    }
    this.askAgentMemorySummaryTimers.clear();
    for (const controller of this.askAgentMemorySummaryControllers.values()) {
      controller.abort();
    }
    this.askAgentMemorySummaryControllers.clear();

    this.commandRoutes.beginDrain();
    this.dataPlaneRoutes.beginDrain();
    const result = await this.lifecycle.shutdown({
      drain: async () => {
        await this.dispose();
        this.askAgentSseHub.dispose();
        this.relayRoutes.close();
        this.relayStore.close();
      },
      cleanup: async () => {
        if (this.mdnsAdvertiser) {
          try {
            await this.mdnsAdvertiser.stop();
          } catch {
            // ignore
          }
          this.mdnsAdvertiser = null;
        }
        await clearBrowserGatewayHelperDiscovery(this.helperGenerationId);
      },
    });

    this.commandRoutes.close();
    this.dataPlaneRoutes.close();
    this.logAskAgentEvent("helper.stopped", {
      reason,
      helperGenerationId: this.helperGenerationId,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      destroyedSockets: result.destroyedSockets,
      destroyedStreams: result.destroyedStreams,
      drainError:
        result.drainError === undefined ? undefined : String(result.drainError),
      cleanupError:
        result.cleanupError === undefined
          ? undefined
          : String(result.cleanupError),
    });

    process.stdout.write(
      JSON.stringify({
        type: "helper_stopped",
        reason,
        timedOut: result.timedOut,
      }) + "\n",
    );
  }

  handleRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    this.httpRouter.handle(req, res);
  };

  private async handleAskAgentRoute(
    handler: AskAgentRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    switch (handler) {
      case "session":
        return this.handleAskAgentSessionRequest(res);
      case "sessions":
        this.handleAskAgentSessionsRequest(res);
        return;
      case "sessionNew":
        return this.handleAskAgentNewSessionRequest(res);
      case "sessionLoad":
        return this.handleAskAgentLoadSessionRequest(req, res);
      case "sessionDelete":
        return this.handleAskAgentDeleteSessionRequest(req, res);
      case "sessionRename":
        return this.handleAskAgentRenameSessionRequest(req, res);
      case "sessionCopyFirstPrompt":
        return this.handleAskAgentCopyFirstPromptRequest(req, res);
      case "events":
        return this.handleAskAgentEventsRequest(req, res);
      case "models":
        this.handleAskAgentModelsRequest(req, res);
        return;
      case "slashCommands":
        return this.handleAskAgentSlashCommandsRequest(res);
      case "mcpConfig":
        return this.handleAskAgentMcpConfigRequest(req, res);
      case "mcpConfigServer":
        return this.handleAskAgentMcpConfigServerRequest(req, res);
      case "mcpConfigOpenRaw":
        return this.handleAskAgentMcpConfigOpenRawRequest(req, res);
      case "mcpStatus":
        return this.handleAskAgentMcpStatusRequest(req, res);
      case "mcpRefresh":
        return this.handleAskAgentMcpRefreshRequest(req, res);
      case "question":
        return this.handleAskAgentQuestionResponseRequest(req, res);
      case "questionProgress":
        return this.handleAskAgentQuestionProgressRequest(req, res);
      case "memory":
        return this.handleAskAgentMemoryStatusRequest(res);
      case "memoryClear":
        return this.handleAskAgentMemoryClearRequest(req, res);
      case "autonomousMemoryHealth":
        return this.handleAskAgentAutonomousMemoryHealthRequest(res);
      case "autonomousMemoryActivity":
        return this.handleAskAgentAutonomousMemoryActivityRequest(res);
      case "autonomousMemoryQuery":
        return this.handleAskAgentAutonomousMemoryQueryRequest(req, res);
      case "autonomousMemoryDetail":
        return this.handleAskAgentAutonomousMemoryDetailRequest(req, res);
      case "autonomousMemoryManage":
        return this.handleAskAgentAutonomousMemoryManageRequest(req, res);
      case "autonomousMemoryClear":
        return this.handleAskAgentAutonomousMemoryClearRequest(req, res);
      case "autonomousMemoryExport":
        return this.handleAskAgentAutonomousMemoryExportRequest(res);
      case "autonomousMemoryImport":
        return this.handleAskAgentAutonomousMemoryImportRequest(req, res);
      case "log":
        return this.handleAskAgentUiLogRequest(req, res);
      case "model":
        return this.handleAskAgentModelRequest(req, res);
      case "memoryProposal":
        return this.handleAskAgentMemoryProposalRequest(req, res);
      case "memoryNudgeDismiss":
        return this.handleAskAgentMemoryCandidateNudgeDismissRequest(req, res);
      case "memoryApproval":
        return this.handleAskAgentMemoryApprovalRequest(req, res);
      case "approval":
        return this.handleAskAgentApprovalRequest(req, res);
      case "readGrants":
        return this.handleAskAgentReadGrantsRequest(res);
      case "readGrantAdd":
        return this.handleAskAgentReadGrantAddRequest(req, res);
      case "readGrantRevoke":
        return this.handleAskAgentReadGrantRevokeRequest(req, res);
      case "projectHandoffTargets":
        return this.handleAskAgentProjectHandoffTargetsRequest(res);
      case "projectHandoffPropose":
        return this.handleAskAgentProjectHandoffProposeRequest(req, res);
      case "projectHandoffCancel":
        return this.handleAskAgentProjectHandoffCancelRequest(req, res);
      case "projectHandoffApprove":
        return this.handleAskAgentProjectHandoffApproveRequest(req, res);
      case "thinking":
        return this.handleAskAgentThinkingRequest(req, res);
      case "send":
        return this.handleAskAgentSendRequest(req, res);
      case "retry":
        return this.handleAskAgentRetryRequest(req, res);
      case "stop":
        return this.handleAskAgentStopRequest(res);
    }
  }

  private async handlePublicRoute(
    handler: PublicHelperRouteHandler,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    switch (handler) {
      case "health": {
        const dataPlaneMode = await this.resolveEffectiveDataPlaneMode();
        const payload: BrowserGatewayHelperHealthResponse = {
          status: "ok",
          protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
          helperVersion: this.options.helperVersion,
          startedAt: this.startedAt.toISOString(),
          now: new Date().toISOString(),
          uptimeMs: Date.now() - this.startedAtMs,
          activeClientLeases: this.getActiveLeaseCount(),
          helperGenerationId: this.helperGenerationId,
          dataPlaneMode,
          dataPlaneFeatures: [...BROWSER_GATEWAY_DATA_PLANE_FEATURES],
          coreOwners: this.coreOwnerRegistry.list(Date.now()).length,
        };
        writeJson(res, 200, payload);
        return;
      }
      case "root":
        return this.handleRootRequest(req, requestUrl, res);
      case "browserGatewayJs":
        return this.handleStaticAssetRequest(
          "dist/browser-gateway.js",
          "text/javascript; charset=utf-8",
          res,
        );
      case "browserGatewayCss":
        return this.handleStaticAssetRequest(
          "dist/browser-gateway.css",
          "text/css; charset=utf-8",
          res,
        );
      case "browserGatewayMonacoJs":
        return this.handleStaticAssetRequest(
          "dist/browser-gateway-monaco.js",
          "text/javascript; charset=utf-8",
          res,
        );
      case "browserGatewayMonacoCss":
        return this.handleStaticAssetRequest(
          "dist/browser-gateway-monaco.css",
          "text/css; charset=utf-8",
          res,
        );
      case "browserGatewayChunk":
        return this.handleStaticAssetRequest(
          `dist${pathname}`,
          "text/javascript; charset=utf-8",
          res,
          "public, max-age=31536000, immutable",
        );
      case "monacoWorker":
        return this.handleStaticAssetRequest(
          `dist/${pathname.slice(1)}`,
          "text/javascript; charset=utf-8",
          res,
        );
      case "monacoWorkerMap":
        return this.handleStaticAssetRequest(
          `dist/${pathname.slice(1)}`,
          "application/json; charset=utf-8",
          res,
        );
      case "codiconCss":
        return this.handleStaticAssetRequest(
          "dist/codicon.css",
          "text/css; charset=utf-8",
          res,
        );
      case "codiconFont":
        return this.handleStaticAssetRequest(
          "dist/codicon.ttf",
          "font/ttf",
          res,
        );
      case "appIcon":
        return this.handleAppIconRequest(res);
      case "appIconSvg":
        return this.handleStaticAssetRequest(
          "media/agentlink-terminal.svg",
          "image/svg+xml; charset=utf-8",
          res,
        );
      case "webManifest":
        this.handleWebManifestRequest(res);
        return;
    }
  }

  private async handleBrowserRelayRoute(
    handler: BrowserRelayRouteHandler,
    auth: AuthResult,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    if (auth.kind === "none") {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const identity: BrowserRelayAuthIdentity =
      auth.kind === "device"
        ? { sessionKey: `device:${auth.deviceId}`, deviceId: auth.deviceId }
        : { sessionKey: "bootstrap" };
    await this.relayRoutes.handle(handler, identity, req, res, requestUrl);
  }

  private async handlePairedBrowserRoute(
    handler: PairedBrowserRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    switch (handler) {
      case "pairGet":
        return this.handlePairingPageGet(res, null);
      case "pairPost":
        return this.handlePairingPagePost(req, res);
    }
  }

  private async handleInternalDeviceRoute(
    handler: InternalDeviceRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    switch (handler) {
      case "pairingCreate":
        return this.handlePairingCreate(req, res);
      case "pairingCancel":
        return this.handlePairingCancel(req, res);
      case "pairingStatus":
        return this.handlePairingStatus(requestUrl, res);
      case "devices":
        return this.handleDevicesList(res);
      case "deviceRevoke":
        return this.handleDevicesRevoke(req, res);
    }
  }

  private async handleInternalDataPlaneRoute(
    handler: InternalDataPlaneRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    await this.dataPlaneRoutes.handle(handler, req, res, requestUrl);
  }

  private async handleInternalCoreRoute(
    handler: InternalCoreRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    switch (handler) {
      case "clientLease":
        return this.handleLeaseRequest(req, res);
      case "clientRelease":
        return this.handleReleaseRequest(req, res);
      case "coreOwnerRegister":
        return this.handleCoreOwnerRegisterRequest(req, res);
      case "coreOwnerHeartbeat":
        return this.handleCoreOwnerHeartbeatRequest(req, res);
      case "coreOwners":
        this.handleCoreOwnersListRequest(res);
        return;
      case "modelCatalog":
        return this.handleModelCatalogPublishRequest(req, res);
      case "modelCredentialGrant":
        return this.handleModelCredentialGrantRequest(req, res);
      case "modelCredentialClear":
        return this.handleModelCredentialClearRequest(req, res);
      case "modelAuthLease":
        return this.handleModelAuthLeaseRequest(req, res);
      case "modelAuthLeaseValidate":
        return this.handleModelAuthLeaseValidateRequest(req, res);
      case "modelAuthLeaseRevoke":
        return this.handleModelAuthLeaseRevokeRequest(req, res);
    }
  }

  private async handleRootRequest(
    req: http.IncomingMessage,
    requestUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const loopback = isLoopbackAddress(req.socket.remoteAddress);
    const auth = await this.authenticateRequest(req);

    // Loopback: trusted, auto-issue bootstrap cookie (unchanged behavior).
    if (loopback) {
      const instances = await listHealthyBrowserGatewayInstances();
      const requestedInstanceId = requestUrl.searchParams
        .get("instanceId")
        ?.trim();
      const selectedInstance = this.selectInstance(
        instances,
        requestedInstanceId,
      );
      writeHtml(
        res,
        200,
        this.renderIndexHtml(
          selectedInstance?.instanceId ?? "",
          selectedInstance?.workspaceName ?? "No Workspace",
          await this.resolveInitialTheme(selectedInstance),
          await this.resolveEffectiveDataPlaneMode(),
        ),
        { "Set-Cookie": this.buildBootstrapCookie() },
      );
      return;
    }

    // LAN: require prior pairing. If not authed, show the pairing page.
    if (auth.kind === "none") {
      await this.handlePairingPageGet(res, null);
      return;
    }

    const instances = await listHealthyBrowserGatewayInstances();
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const selectedInstance = this.selectInstance(
      instances,
      requestedInstanceId,
    );
    writeHtml(
      res,
      200,
      this.renderIndexHtml(
        selectedInstance?.instanceId ?? "",
        selectedInstance?.workspaceName ?? "No Workspace",
        await this.resolveInitialTheme(selectedInstance),
        await this.resolveEffectiveDataPlaneMode(),
      ),
    );
    void this.recordDeviceActivity(auth);
  }

  private async handleInstancesRequest(
    requestUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const { registered: registeredInstances, healthy: healthyInstances } =
      await listCheckedBrowserGatewayInstances();
    const coreOwners = this.coreOwnerRegistry.list(Date.now());
    const visibleRegisteredInstances = filterInstancesForVisibleCoreOwners(
      registeredInstances,
      coreOwners,
    );
    const visibleInstanceIds = new Set(
      visibleRegisteredInstances.map((instance) => instance.instanceId),
    );
    const visibleHealthyInstances = healthyInstances.filter((instance) =>
      visibleInstanceIds.has(instance.instanceId),
    );
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const selectedInstance = this.selectInstance(
      visibleHealthyInstances,
      requestedInstanceId,
    );
    const enrichedInstances = await this.buildInstanceListItems(
      visibleRegisteredInstances,
    );
    const dataPlaneMode = this.resolveEffectiveDataPlaneModeFromInstances(
      visibleRegisteredInstances,
    );
    logHelper(
      `/api/instances requestedInstanceId=${requestedInstanceId || "none"} selected=${selectedInstance?.instanceId ?? "none"} registered=${registeredInstances.length} visible=${visibleRegisteredInstances.length} healthy=${healthyInstances.length} registeredIds=${registeredInstances.map((instance) => instance.instanceId).join(",") || "none"}`,
    );

    this.writeInstancesJson(
      res,
      selectedInstance?.instanceId ?? "",
      enrichedInstances,
      200,
      undefined,
      dataPlaneMode,
    );
  }

  private async executeAskAgentSelectSessionCommand(
    sessionId: string,
  ): Promise<void> {
    if (!this.askAgentSessionStore.loadSession(sessionId)) {
      throw new Error("ask_agent_session_not_found");
    }
    await this.persistAskAgentHistory();
    const response = await this.buildAskAgentResponse();
    await this.publishAskAgentSnapshot(response.snapshot);
  }

  private async executeAskAgentSendCommand(params: {
    operationId: string;
    sessionId: string;
    text: string;
    details: readonly AskAgentOwnerResolvedDetail[];
    signal: AbortSignal;
  }): Promise<void> {
    if (params.signal.aborted) throw new Error("ask_agent_command_cancelled");
    const cancel = (): void => {
      void this.cancelActiveTurn();
    };
    params.signal.addEventListener("abort", cancel, { once: true });
    const images: BrowserGatewayAskAgentMediaItem[] = [];
    const documents: BrowserGatewayAskAgentMediaItem[] = [];
    for (const detail of params.details) {
      const mimeType = detail.handle.mediaType?.trim();
      if (!mimeType) throw new Error("ask_agent_media_type_required");
      const media = {
        name: detail.handle.handleId,
        mimeType,
        base64: Buffer.from(detail.content).toString("base64"),
      };
      if (mimeType.startsWith("image/")) images.push(media);
      else documents.push(media);
    }
    try {
      const result = await invokeJsonHandlerInProcess(
        {
          id: params.operationId,
          sessionId: params.sessionId,
          text: params.text,
          images,
          documents,
        },
        (req, res) => this.handleAskAgentSendRequest(req, res),
      );
      assertSuccessfulAskAgentCommand(result);
    } finally {
      params.signal.removeEventListener("abort", cancel);
    }
  }

  private async executeAskAgentStopCommand(sessionId: string): Promise<void> {
    if (this.askAgentSessionStore.getActiveSessionId() !== sessionId) {
      throw new Error("ask_agent_session_not_found");
    }
    await this.cancelActiveTurn();
  }

  private async executeAskAgentApprovalCommand(params: {
    requestId: string;
    decision: "approve" | "reject";
  }): Promise<void> {
    const request = this.askAgentController.submitApproval({
      type: "decision",
      id: params.requestId,
      decision: params.decision === "approve" ? "accept" : "reject",
    });
    if (!request) throw new Error("approval_not_found");
    const response = await this.buildAskAgentResponse();
    await this.publishAskAgentSnapshot(response.snapshot);
    this.logAskAgentEvent("ask-agent.approval", {
      ok: true,
      approvalId: params.requestId,
      kind: request.kind,
      decision: params.decision,
    });
  }

  private async executeAskAgentQuestionCommand(params: {
    requestId: string;
    response: unknown;
    signal: AbortSignal;
  }): Promise<void> {
    if (params.signal.aborted) throw new Error("ask_agent_command_cancelled");
    if (!params.response || typeof params.response !== "object") {
      throw new Error("ask_agent_question_detail_invalid");
    }
    const cancel = (): void => {
      void this.cancelActiveTurn();
    };
    params.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await invokeJsonHandlerInProcess(
        {
          ...(params.response as Record<string, unknown>),
          id: params.requestId,
        },
        (req, res) => this.handleAskAgentQuestionResponseRequest(req, res),
      );
      assertSuccessfulAskAgentCommand(result);
    } finally {
      params.signal.removeEventListener("abort", cancel);
    }
  }

  private loadAskAgentHistoryCommand(params: {
    cursor: string;
    count: number;
  }): {
    messages: ChatMessage[];
    earlierCursor: string | null;
    hasEarlier: boolean;
  } {
    const activeSessionId = this.askAgentSessionStore.getActiveSessionId();
    const prefix = `${activeSessionId}:`;
    if (!params.cursor.startsWith(prefix)) {
      throw new Error("ask_agent_history_cursor_invalid");
    }
    const end = Number(params.cursor.slice(prefix.length));
    const messages = this.askAgentSessionStore.getProjectedMessages();
    if (!Number.isSafeInteger(end) || end < 0 || end > messages.length) {
      throw new Error("ask_agent_history_cursor_invalid");
    }
    const start = Math.max(0, end - params.count);
    return {
      messages: messages.slice(start, end),
      earlierCursor: start > 0 ? `${activeSessionId}:${start}` : null,
      hasEarlier: start > 0,
    };
  }

  private async handleAskAgentSessionRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    writeJson(res, 200, await this.buildAskAgentResponse());
  }

  private handleAskAgentSessionsRequest(res: http.ServerResponse): void {
    writeJson(res, 200, { sessions: this.askAgentSessionStore.listSessions() });
  }

  private async handleAskAgentNewSessionRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    this.askAgentSessionStore.createSession(Date.now());
    await this.persistAskAgentHistory();
    const response = await this.buildAskAgentResponse();
    await this.publishAskAgentSnapshot(response.snapshot);
    writeJson(res, 200, { ok: true, snapshot: response.snapshot });
  }

  private async handleAskAgentLoadSessionRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { sessionId?: unknown } | null;
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      if (!sessionId || !this.askAgentSessionStore.loadSession(sessionId)) {
        writeJson(res, 404, { error: "ask_agent_session_not_found" });
        return;
      }
      await this.persistAskAgentHistory();
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentDeleteSessionRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { sessionId?: unknown } | null;
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      if (
        !sessionId ||
        !this.askAgentSessionStore
          .getHistorySnapshot()
          .sessions.some((session) => session.id === sessionId)
      ) {
        writeJson(res, 404, {
          ok: false,
          error: "ask_agent_session_not_found",
          message: "Ask Agent session not found.",
        });
        return;
      }
      this.cancelAskAgentMemorySummary(sessionId);
      await this.deleteAskAgentDerivedSession(sessionId);
      if (!this.askAgentSessionStore.deleteSession(sessionId)) {
        throw new Error("ask_agent_session_delete_race");
      }
      await this.persistAskAgentHistory();
      this.askAgentController.clearMemoryCandidateNudgeForSession(sessionId);
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentRenameSessionRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as {
        sessionId?: unknown;
        title?: unknown;
      } | null;
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (
        !sessionId ||
        !title ||
        !this.askAgentSessionStore.renameSession(sessionId, title)
      ) {
        writeJson(res, 400, {
          ok: false,
          error: "invalid_request",
          message: "Unable to rename Ask Agent session.",
        });
        return;
      }
      await this.persistAskAgentHistory();
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentQuestionResponseRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let activeTurn: AskAgentControllerTurn | null = null;
    try {
      const body = (await readJsonBody(req)) as {
        id?: unknown;
        answers?: unknown;
        notes?: unknown;
        attachments?: unknown;
      } | null;
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      const answers =
        body?.answers &&
        typeof body.answers === "object" &&
        !Array.isArray(body.answers)
          ? (body.answers as Record<
              string,
              string | string[] | number | boolean | undefined
            >)
          : {};
      const notes: Record<string, string> = {};
      if (
        body?.notes &&
        typeof body.notes === "object" &&
        !Array.isArray(body.notes)
      ) {
        for (const [key, value] of Object.entries(body.notes)) {
          notes[key] = typeof value === "string" ? value : String(value ?? "");
        }
      }
      const attachments = normalizeUserQuestionAttachments(body?.attachments);
      const now = Date.now();
      const theme = await this.resolveInitialTheme(null);
      const modelContext = this.getAskAgentModelExecutionContext(now);
      if (!modelContext) {
        this.logAskAgentEvent("ask-agent.question.response", {
          id,
          ok: false,
          error: "credential_missing",
        });
        writeJson(res, 409, { error: "credential_missing" });
        return;
      }
      if (this.askAgentController.hasActiveTurn()) {
        this.logAskAgentEvent("ask-agent.question.response", {
          id,
          ok: false,
          error: "ask_agent_turn_in_progress",
        });
        writeJson(res, 409, { error: "ask_agent_turn_in_progress" });
        return;
      }

      const answerResult = id
        ? this.askAgentSessionStore.answerQuestion(
            id,
            answers,
            notes,
            attachments,
          )
        : null;
      if (!answerResult) {
        writeJson(res, 404, {
          ok: false,
          error: "ask_agent_question_not_found",
        });
        return;
      }

      const responseContent = JSON.stringify({
        ok: true,
        responses: answerResult.responses,
      });
      const modelMedia: CoreModelContentBlock[] = [];
      for (const attachment of answerResult.media) {
        if (!attachment.base64 || !attachment.mimeType) continue;
        if (attachment.kind === "image") {
          const mediaType = toCoreModelImageMediaType(attachment.mimeType);
          if (!mediaType) continue;
          modelMedia.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: attachment.base64,
            },
          });
        } else if (attachment.kind === "document") {
          const mediaType = toCoreModelDocumentMediaType(attachment.mimeType);
          if (!mediaType) continue;
          modelMedia.push({
            type: "document",
            title: attachment.name,
            source: {
              type: "base64",
              media_type: mediaType,
              data: attachment.base64,
            },
          });
        }
      }
      const resultImages = answerResult.media.flatMap((attachment) =>
        attachment.kind === "image" && attachment.base64 && attachment.mimeType
          ? [{ mimeType: attachment.mimeType, data: attachment.base64 }]
          : [],
      );
      const resultDocuments = answerResult.media.flatMap((attachment) =>
        attachment.kind === "document" &&
        attachment.base64 &&
        attachment.mimeType
          ? [
              {
                name: attachment.name,
                mimeType: attachment.mimeType,
                data: attachment.base64,
              },
            ]
          : [],
      );
      this.askAgentController.completeAssistantToolCall({
        messageId: answerResult.messageId,
        toolCallId: answerResult.toolCallId,
        toolName: "ask_user",
        input: {},
        result: responseContent,
        ...(resultImages.length > 0 ? { resultImages } : {}),
        ...(resultDocuments.length > 0 ? { resultDocuments } : {}),
        durationMs: 0,
      });
      const answerToolMessage = this.buildAskAgentToolResultMessage(
        { id: answerResult.toolCallId, name: "ask_user", input: {} },
        responseContent,
        false,
        modelMedia.length > 0
          ? [{ type: "text", text: responseContent }, ...modelMedia]
          : responseContent,
      );
      this.logAskAgentEvent("ask-agent.question.response", {
        id,
        ok: true,
        phase: "received",
      });

      let response: ReturnType<typeof this.buildAskAgentSnapshotResponse>;
      let sendOutcome = "model_success";
      activeTurn = this.askAgentController.beginTurn(answerResult.messageId);
      if (!activeTurn) throw new Error("ask_agent_turn_in_progress");
      try {
        const transcriptMessages =
          this.askAgentSessionStore.getTranscriptMessages();
        const turnResult = await this.runAskAgentModelTurn({
          modelContext,
          assistantMessageId: answerResult.messageId,
          transcriptMessages,
          initialToolMessages: [answerToolMessage],
          theme,
          signal: activeTurn.signal,
        });
        sendOutcome = turnResult.outcome;
      } catch (err) {
        const authFailed =
          err instanceof Error &&
          err.message === "browser_gateway_ask_agent_model_auth_failed";
        const stopped =
          err instanceof Error &&
          err.message === "browser_gateway_ask_agent_model_aborted";
        const alreadyStopped =
          stopped && this.askAgentController.isTurnStopped(activeTurn);
        const errorPresentation = buildAskAgentModelErrorPresentation({
          error: err,
          authFailed,
          stopped,
        });
        if (authFailed) {
          this.clearAskAgentModelCredential();
        }
        sendOutcome = stopped
          ? "model_stopped"
          : authFailed
            ? "model_auth_failed"
            : "model_error";
        this.logAskAgentEvent("ask-agent.question.response.model_error", {
          id,
          ...getSanitizedModelErrorFields(err),
          ok: false,
          error: sendOutcome,
        });
        if (!alreadyStopped) {
          this.askAgentController.finishAssistantError({
            messageId: answerResult.messageId,
            text: errorPresentation.message,
            code: errorPresentation.code ?? sendOutcome,
            retryable: errorPresentation.retryable,
            actions: errorPresentation.actions,
            preserveCompletedAskUserBlocks: true,
          });
        }
      }
      this.askAgentController.recordTurnOutcome(
        this.askAgentSessionStore.getActiveSessionId(),
        sendOutcome,
      );
      response = this.buildAskAgentSnapshotResponse(Date.now(), theme);
      this.logAskAgentEvent("ask-agent.question.response.complete", {
        id,
        ok: true,
        outcome: sendOutcome,
        messageCount:
          response.snapshot.session.foreground.projectedMessages.length,
      });

      await this.persistAskAgentHistory();
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.question.response", {
        ok: false,
        error: invalidJson ? "invalid_json" : "internal_error",
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    } finally {
      if (activeTurn) this.askAgentController.completeTurn(activeTurn);
    }
  }

  private async handleAskAgentQuestionProgressRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as {
        id?: unknown;
        step?: unknown;
        answers?: unknown;
        notes?: unknown;
        origin?: unknown;
      } | null;
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      const step = Number(body?.step ?? 0);
      const answers =
        body?.answers &&
        typeof body.answers === "object" &&
        !Array.isArray(body.answers)
          ? (body.answers as Record<
              string,
              string | string[] | number | boolean | undefined
            >)
          : {};
      const notes: Record<string, string> = {};
      if (
        body?.notes &&
        typeof body.notes === "object" &&
        !Array.isArray(body.notes)
      ) {
        for (const [key, value] of Object.entries(body.notes)) {
          notes[key] = typeof value === "string" ? value : String(value ?? "");
        }
      }
      const origin = typeof body?.origin === "string" ? body.origin.trim() : "";
      if (
        !id ||
        !Number.isInteger(step) ||
        step < 0 ||
        !this.askAgentSessionStore.setQuestionProgress({
          id,
          step,
          answers,
          notes,
          origin,
        })
      ) {
        writeJson(res, 404, {
          ok: false,
          error: "ask_agent_question_not_found",
        });
        return;
      }
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.question.progress", {
        id,
        step,
        ok: true,
      });
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.question.progress", {
        ok: false,
        error: invalidJson ? "invalid_json" : "internal_error",
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentCopyFirstPromptRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { sessionId?: unknown } | null;
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const prompt = sessionId
        ? this.askAgentSessionStore.getFirstPrompt(sessionId)
        : null;
      if (!prompt) {
        writeJson(res, 404, { error: "ask_agent_prompt_not_found" });
        return;
      }
      writeJson(res, 200, { ok: true, prompt });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private restoreState(
    preferences: Parameters<
      BrowserGatewayAskAgentSessionStore["applyPreferences"]
    >[0],
    history: Parameters<BrowserGatewayAskAgentSessionStore["loadHistory"]>[0],
  ): void {
    this.askAgentModelOwnerId = preferences.modelOwnerId;
    this.askAgentController.restoreState(preferences, history);
  }

  private async buildAskAgentResponse(): Promise<AskAgentSessionResponse> {
    const now = Date.now();
    return this.buildAskAgentSnapshotResponse(
      now,
      await this.resolveInitialTheme(null),
    );
  }

  private maybeCreateAskAgentMemoryCandidateNudge(params: {
    text: string;
    priorUserTexts: string[];
    sessionId: string;
    now: number;
  }): void {
    const candidate =
      detectMemoryCandidates(params.text, params.priorUserTexts).find(
        (item) => item.suggestedScope === "global",
      ) ?? null;
    this.askAgentController.considerMemoryCandidate({
      sessionId: params.sessionId,
      now: params.now,
      candidate,
      approvalPending: Boolean(
        this.askAgentMemoryProposalBridge.getPendingApproval(),
      ),
    });
  }

  private buildAskAgentSnapshotResponse(
    now: number,
    theme: BrowserGatewayThemeSnapshot,
  ): AskAgentSessionResponse {
    const state = this.askAgentController.projectState({
      now,
      theme,
      modelCredentialStatus: this.getAskAgentModelCredentialStatus(now),
      approval:
        this.askAgentMemoryProposalBridge.getPendingApproval() ??
        this.askAgentController.getPendingApproval(),
      memoryCandidateNudge: this.askAgentController.getMemoryCandidateNudge(),
    });
    return { ok: true, ...state };
  }

  private async persistAskAgentHistory(): Promise<void> {
    await this.askAgentHistoryStore.write(
      this.askAgentSessionStore.getHistorySnapshot(),
    );
  }

  private async refreshAskAgentDerivedSessionRuntime(): Promise<void> {
    const connected = this.coreOwnerRegistry
      .list(Date.now())
      .filter(
        (registration) =>
          registration.status === "connected" &&
          registration.owner.ownerId !== BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      )
      .map((registration) => {
        const ownerId = registration.owner.ownerId;
        const descriptor = this.askAgentMemoryRuntimeByOwner.get(ownerId);
        return descriptor
          ? { ownerId, retrievalStoreRoot: descriptor.retrievalStoreRoot }
          : { ownerId };
      });
    await this.askAgentDerivedSessionRuntime.setOwners(connected);
  }

  private async getAskAgentDerivedSession(
    sessionId: string,
  ): Promise<DerivedSessionSummary | undefined> {
    if (this.askAgentMemoryStore) {
      const session = (await this.askAgentMemoryStore.read()).sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      return session
        ? {
            ...session,
            surface: "browser-ask-agent",
            scope: { kind: "global", id: "agentlink-user" },
          }
        : undefined;
    }
    await this.refreshAskAgentDerivedSessionRuntime();
    return (
      await this.askAgentDerivedSessionRuntime.inspect({
        scopes: [{ kind: "global", id: "agentlink-user" }],
        surfaces: ["browser-ask-agent"],
      })
    ).sessions.find((session) => session.sessionId === sessionId);
  }

  private async upsertAskAgentDerivedSession(
    session: DerivedSessionSummary,
    chunk: DerivedSessionChunk,
  ): Promise<void> {
    if (this.askAgentMemoryStore) {
      await this.askAgentMemoryStore.update((snapshot) => {
        const sessions = snapshot.sessions.filter(
          (candidate) => candidate.sessionId !== session.sessionId,
        );
        const chunks = snapshot.chunks.filter(
          (candidate) => candidate.id !== chunk.id,
        );
        sessions.push(session);
        chunks.push(chunk);
        return {
          ...snapshot,
          updatedAt: Math.max(snapshot.updatedAt, session.updatedAt),
          sessions,
          chunks,
        };
      });
      return;
    }
    await this.refreshAskAgentDerivedSessionRuntime();
    await this.askAgentDerivedSessionRuntime.publish({
      session,
      chunks: [chunk],
    });
  }

  private async searchAskAgentDerivedSessions(params: {
    query: string;
    activeSessionId: string;
    recentMessageIds: readonly string[];
    limit: number;
  }): Promise<BrowserGatewayAskAgentMemorySearchResult[]> {
    if (this.askAgentMemoryStore) {
      return await this.askAgentMemoryStore.search(params.query, {
        activeSessionId: params.activeSessionId,
        recentMessageIds: params.recentMessageIds,
        limit: params.limit,
      });
    }
    await this.refreshAskAgentDerivedSessionRuntime();
    return await this.askAgentDerivedSessionRuntime.recall({
      query: params.query,
      scopes: [{ kind: "global", id: "agentlink-user" }],
      surfaces: ["browser-ask-agent"],
      activeSessionId: params.activeSessionId,
      visibleMessageIds: params.recentMessageIds,
      limit: params.limit,
    });
  }

  private async listAskAgentDerivedSessions(): Promise<{
    sessions: BrowserGatewayAskAgentSessionMemory[];
    chunkCount: number;
  }> {
    if (this.askAgentMemoryStore) {
      const snapshot = await this.askAgentMemoryStore.read();
      return {
        sessions: snapshot.sessions,
        chunkCount: snapshot.chunks.length,
      };
    }
    await this.refreshAskAgentDerivedSessionRuntime();
    const inspection = await this.askAgentDerivedSessionRuntime.inspect({
      scopes: [{ kind: "global", id: "agentlink-user" }],
      surfaces: ["browser-ask-agent"],
    });
    return {
      sessions: inspection.sessions.map(
        ({ surface: _surface, scope: _scope, ...session }) => session,
      ),
      chunkCount: inspection.chunkCount,
    };
  }

  private async deleteAskAgentDerivedSession(sessionId: string): Promise<void> {
    if (this.askAgentMemoryStore) {
      await this.askAgentMemoryStore.deleteSessionMemory(sessionId);
      return;
    }
    await this.refreshAskAgentDerivedSessionRuntime();
    await this.askAgentDerivedSessionRuntime.deleteSession({
      sessionId,
      surface: "browser-ask-agent",
      scope: { kind: "global", id: "agentlink-user" },
    });
  }

  private async clearAskAgentDerivedSessions(): Promise<void> {
    if (this.askAgentMemoryStore) {
      await this.askAgentMemoryStore.clear();
      return;
    }
    await this.refreshAskAgentDerivedSessionRuntime();
    await this.askAgentDerivedSessionRuntime.clearScope({
      scope: { kind: "global", id: "agentlink-user" },
      surface: "browser-ask-agent",
    });
  }

  private scheduleAskAgentMemorySummary(sessionId: string): void {
    const session = this.askAgentSessionStore
      .getHistorySnapshot()
      .sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.messages.length < 2) return;

    const modelContext = this.getAskAgentModelExecutionContext(Date.now());
    if (!modelContext) {
      this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
        sessionId,
        reason: "credential_unavailable",
      });
      return;
    }

    const existingTimer = this.askAgentMemorySummaryTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const existingController =
      this.askAgentMemorySummaryControllers.get(sessionId);
    if (existingController) {
      existingController.abort();
      this.askAgentMemorySummaryControllers.delete(sessionId);
    }

    const messages = session.messages.map((message) => ({ ...message }));
    const revision = getAskAgentMemorySourceRevision(messages);
    if (this.askAgentMemorySecretSkippedRevisions.get(sessionId) === revision) {
      this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
        sessionId,
        reason: "secret_like_revision",
      });
      return;
    }
    const scheduledAt = Date.now();
    const timer = setTimeout(() => {
      this.askAgentMemorySummaryTimers.delete(sessionId);
      void this.runAskAgentMemorySummary({
        session: {
          ...session,
          messages,
        },
        revision,
        scheduledAt,
      });
    }, this.askAgentMemorySummaryDebounceMs);
    this.askAgentMemorySummaryTimers.set(sessionId, timer);
    this.logAskAgentEvent("ask-agent.memory.summary.scheduled", {
      sessionId,
      messageCount: messages.length,
      debounceMs: this.askAgentMemorySummaryDebounceMs,
    });
  }

  private cancelAskAgentMemorySummary(sessionId: string): void {
    const timer = this.askAgentMemorySummaryTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.askAgentMemorySummaryTimers.delete(sessionId);
    }
    const controller = this.askAgentMemorySummaryControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.askAgentMemorySummaryControllers.delete(sessionId);
    }
    this.askAgentMemorySecretSkippedRevisions.delete(sessionId);
  }

  private async runAskAgentMemorySummary(params: {
    session: BrowserGatewayAskAgentPersistedSession;
    revision: string;
    scheduledAt: number;
  }): Promise<void> {
    const { session, revision, scheduledAt } = params;
    const modelContext = this.getAskAgentModelExecutionContext(Date.now());
    if (!modelContext) {
      this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
        sessionId: session.id,
        reason: "credential_unavailable",
      });
      return;
    }
    const controller = new AbortController();
    this.askAgentMemorySummaryControllers.set(session.id, controller);
    try {
      const existingSession = await this.getAskAgentDerivedSession(session.id);
      if (existingSession?.sourceRevision === revision) {
        this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
          sessionId: session.id,
          reason: "unchanged_revision",
        });
        return;
      }

      const summary = await this.askAgentSummarizer.summarize({
        credential: modelContext.credential,
        providerId: modelContext.providerId,
        openAiCompatibleRuntimeProfile:
          modelContext.openAiCompatibleRuntimeProfile,
        model: modelContext.model,
        reasoningEffort: this.askAgentSessionStore.getReasoningEffort(),
        messages: session.messages,
        existingSessionSummary: existingSession?.summary,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      const secretFinding = findAskAgentSummarySecretLikeContent(summary);
      if (controller.signal.aborted) return;
      if (secretFinding) {
        this.askAgentMemorySecretSkippedRevisions.set(session.id, revision);
        await this.deleteAskAgentDerivedSession(session.id);
        this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
          sessionId: session.id,
          reason: "secret_like_content",
          field: secretFinding.field,
          pattern: secretFinding.pattern,
        });
        return;
      }

      const latestTurn = this.getLatestAskAgentCompletedTurn(session.messages);
      if (!latestTurn) {
        this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
          sessionId: session.id,
          reason: "no_completed_turn",
        });
        return;
      }
      const currentSession = this.askAgentSessionStore
        .getHistorySnapshot()
        .sessions.find((candidate) => candidate.id === session.id);
      const currentRevision = currentSession
        ? getAskAgentMemorySourceRevision(currentSession.messages)
        : "";
      if (currentRevision !== revision) {
        this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
          sessionId: session.id,
          reason: "stale_revision",
        });
        return;
      }

      const now = Date.now();
      const sessionMemory: DerivedSessionSummary = {
        sessionId: session.id,
        surface: "browser-ask-agent",
        scope: { kind: "global", id: "agentlink-user" },
        title: summary.title || session.title || "Ask Agent",
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        messageCount: session.messages.length,
        sourceRevision: revision,
        summary: summary.summary,
        topics: summary.topics,
        decisions: summary.decisions,
        openQuestions: summary.openQuestions,
        durableCandidateHints: summary.durableCandidateHints,
        updatedAt: now,
      };
      const chunk: DerivedSessionChunk = {
        id: `${session.id}:${latestTurn.startMessageIndex}-${latestTurn.endMessageIndex}`,
        sessionId: session.id,
        sourceMessageIds: latestTurn.sourceMessageIds,
        startMessageIndex: latestTurn.startMessageIndex,
        endMessageIndex: latestTurn.endMessageIndex,
        sourceRevision: revision,
        summary: summary.latestTurn.summary,
        keywords: summary.latestTurn.keywords,
        entities: summary.latestTurn.entities,
        createdAt: scheduledAt,
        updatedAt: now,
      };
      if (controller.signal.aborted) return;
      this.askAgentMemorySecretSkippedRevisions.delete(session.id);
      await this.upsertAskAgentDerivedSession(sessionMemory, chunk);
      this.logAskAgentEvent("ask-agent.memory.summary.complete", {
        sessionId: session.id,
        messageCount: session.messages.length,
        chunkId: chunk.id,
      });
    } catch (err) {
      const authFailed =
        err instanceof Error &&
        err.message === "browser_gateway_ask_agent_memory_auth_failed";
      if (authFailed) {
        this.clearAskAgentModelCredential();
      }
      this.logAskAgentEvent("ask-agent.memory.summary.failed", {
        sessionId: session.id,
        error: authFailed ? "auth_failed" : "summary_failed",
        ...getSanitizedModelErrorFields(err),
      });
    } finally {
      if (
        this.askAgentMemorySummaryControllers.get(session.id) === controller
      ) {
        this.askAgentMemorySummaryControllers.delete(session.id);
      }
    }
  }

  private async buildAskAgentMemoryContext(params: {
    query: string;
    activeSessionId: string;
    transcriptMessages: readonly ChatMessage[];
  }): Promise<AskAgentMemoryContextResult | undefined> {
    try {
      const recentMessageIds = params.transcriptMessages
        .map((message) => message.id)
        .filter(Boolean);
      const pastIntent = hasAskAgentMemoryPastIntent(params.query);
      const results = await this.searchAskAgentDerivedSessions({
        query: params.query,
        activeSessionId: params.activeSessionId,
        recentMessageIds,
        limit: 5,
      });
      if (results.length === 0 && !pastIntent) {
        this.logAskAgentEvent("ask-agent.memory.context.omitted", {
          sessionId: params.activeSessionId,
          reason: "no_relevant_memory",
        });
        return undefined;
      }
      const memoryContext = results.length
        ? formatAskAgentMemoryContext(results)
        : undefined;
      const indexSessions = pastIntent
        ? await this.buildAskAgentMemoryIndexSessions({
            activeSessionId: params.activeSessionId,
          })
        : [];
      const indexContext = formatAskAgentMemoryIndexContext(indexSessions);
      const transcriptExcerpts = pastIntent
        ? await this.buildAskAgentTranscriptExcerpts({
            results,
            activeSessionId: params.activeSessionId,
            recentMessageIds,
          })
        : [];
      const excerptContext =
        formatAskAgentTranscriptExcerptContext(transcriptExcerpts);
      const context = [memoryContext, indexContext, excerptContext]
        .filter(Boolean)
        .join("\n\n");
      if (!context) {
        this.logAskAgentEvent("ask-agent.memory.context.omitted", {
          sessionId: params.activeSessionId,
          reason: "no_relevant_memory",
        });
        return undefined;
      }
      this.logAskAgentEvent("ask-agent.memory.context", {
        sessionId: params.activeSessionId,
        resultCount: results.length,
        indexSessionCount: indexSessions.length,
        excerptCount: transcriptExcerpts.length,
        chars: context.length,
      });
      return {
        context,
        disclosure: this.buildAskAgentMemoryDisclosure(
          results,
          transcriptExcerpts,
          indexSessions,
        ),
      };
    } catch (err) {
      this.logAskAgentEvent("ask-agent.memory.context.failed", {
        sessionId: params.activeSessionId,
        ...getSanitizedModelErrorFields(err),
      });
      return undefined;
    }
  }

  private buildAskAgentMemoryDisclosure(
    results: readonly BrowserGatewayAskAgentMemorySearchResult[],
    transcriptExcerpts: readonly AskAgentTranscriptExcerpt[],
    indexSessions: readonly BrowserGatewayAskAgentSessionMemory[] = [],
  ): AskAgentMemoryDisclosure {
    const sources: AskAgentMemoryDisclosure["sources"] = [];
    const seen = new Set<string>();
    let summarySourceCount = 0;
    let transcriptSourceCount = 0;
    const pushSource = (
      source: AskAgentMemoryDisclosure["sources"][number],
    ) => {
      const key = `${source.kind}:${source.label}`;
      if (seen.has(key)) return;
      if (
        source.kind === "summary" &&
        summarySourceCount >= ASK_AGENT_MEMORY_DISCLOSURE_SUMMARY_SOURCE_LIMIT
      ) {
        return;
      }
      if (
        source.kind === "transcript" &&
        transcriptSourceCount >=
          ASK_AGENT_MEMORY_DISCLOSURE_TRANSCRIPT_SOURCE_LIMIT
      ) {
        return;
      }
      if (sources.length >= ASK_AGENT_MEMORY_DISCLOSURE_SOURCE_LIMIT) return;
      seen.add(key);
      sources.push(source);
      if (source.kind === "summary") summarySourceCount += 1;
      if (source.kind === "transcript") transcriptSourceCount += 1;
    };

    for (const result of results) {
      pushSource({
        label: this.getAskAgentMemorySummarySourceLabel(result),
        ...(result.title?.trim() ? { title: result.title.trim() } : {}),
        ...this.buildAskAgentMemoryScoreField(result.score),
        kind: "summary",
      });
    }

    for (const session of indexSessions) {
      pushSource({
        label: `summary:session:${session.sessionId}`,
        ...(session.title.trim() ? { title: session.title.trim() } : {}),
        kind: "summary",
      });
    }

    for (const excerpt of transcriptExcerpts) {
      pushSource({
        label: `transcript:${excerpt.sourceId}`,
        ...(excerpt.title?.trim() ? { title: excerpt.title.trim() } : {}),
        ...this.buildAskAgentMemoryScoreField(excerpt.score),
        kind: "transcript",
      });
    }

    return {
      status: "used",
      summaryCount: this.countAskAgentMemorySummarySources(
        results,
        indexSessions,
      ),
      transcriptExcerptCount: transcriptExcerpts.length,
      sources,
    };
  }

  private countAskAgentMemorySummarySources(
    results: readonly BrowserGatewayAskAgentMemorySearchResult[],
    indexSessions: readonly BrowserGatewayAskAgentSessionMemory[],
  ): number {
    const labels = new Set<string>();
    for (const result of results) {
      labels.add(this.getAskAgentMemorySummarySourceLabel(result));
    }
    for (const session of indexSessions) {
      labels.add(`summary:session:${session.sessionId}`);
    }
    return labels.size;
  }

  private getAskAgentMemorySummarySourceLabel(
    result: BrowserGatewayAskAgentMemorySearchResult,
  ): string {
    return result.kind === "chunk"
      ? `summary:chunk:${result.chunkId ?? result.sessionId}`
      : `summary:session:${result.sessionId}`;
  }

  private async buildAskAgentMemoryIndexSessions(params: {
    activeSessionId: string;
  }): Promise<BrowserGatewayAskAgentSessionMemory[]> {
    const { sessions } = await this.listAskAgentDerivedSessions();
    return sessions
      .filter((session) => session.sessionId !== params.activeSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, ASK_AGENT_MEMORY_INDEX_SESSION_LIMIT);
  }

  private buildAskAgentMemoryScoreField(
    score: number,
  ): Pick<AskAgentMemoryDisclosure["sources"][number], "score"> {
    if (!Number.isFinite(score)) return {};
    return { score: Math.round(score * 100) / 100 };
  }

  private async buildAskAgentTranscriptExcerpts(params: {
    results: readonly BrowserGatewayAskAgentMemorySearchResult[];
    activeSessionId: string;
    recentMessageIds: readonly string[];
  }): Promise<AskAgentTranscriptExcerpt[]> {
    const inMemorySessions =
      this.askAgentSessionStore.getHistorySnapshot().sessions;
    const persistedSessions = (await this.askAgentHistoryStore.read()).sessions;
    const sessions = [
      ...inMemorySessions,
      ...persistedSessions.filter(
        (persisted) =>
          !inMemorySessions.some((current) => current.id === persisted.id),
      ),
    ];
    const recentMessageIds = new Set(params.recentMessageIds);
    const excerpts: AskAgentTranscriptExcerpt[] = [];
    const seen = new Set<string>();
    for (const result of params.results) {
      if (
        result.startMessageIndex === undefined ||
        result.endMessageIndex === undefined
      ) {
        continue;
      }
      const overlapsVisibleActiveTranscript =
        result.sessionId === params.activeSessionId &&
        result.sourceMessageIds.some((messageId) =>
          recentMessageIds.has(messageId),
        );
      if (overlapsVisibleActiveTranscript) continue;
      const session = sessions.find(
        (candidate) => candidate.id === result.sessionId,
      );
      if (!session) continue;
      const rangeKey = `${result.sessionId}:${result.startMessageIndex}:${result.endMessageIndex}`;
      if (seen.has(rangeKey)) continue;
      seen.add(rangeKey);
      const sourceStart = Math.max(0, result.startMessageIndex);
      const sourceEnd = Math.min(
        session.messages.length - 1,
        Math.max(sourceStart, result.endMessageIndex),
      );
      const sourceCount = sourceEnd - sourceStart + 1;
      const extraSlots = Math.max(
        0,
        ASK_AGENT_TRANSCRIPT_EXCERPT_MAX_MESSAGES - sourceCount,
      );
      const before = Math.floor(extraSlots / 2);
      const after = extraSlots - before;
      const startMessageIndex = Math.max(0, sourceStart - before);
      const endMessageIndex = Math.min(
        session.messages.length - 1,
        sourceEnd + after,
      );
      const retained = session.messages
        .map((message, index) => ({ message, index }))
        .slice(startMessageIndex, endMessageIndex + 1)
        .filter(
          ({ message }) =>
            (message.role === "user" || message.role === "assistant") &&
            message.content.trim(),
        )
        .slice(0, ASK_AGENT_TRANSCRIPT_EXCERPT_MAX_MESSAGES);
      if (retained.length === 0) continue;
      excerpts.push({
        sessionId: result.sessionId,
        title: result.title,
        sourceId: result.chunkId ?? result.sessionId,
        score: result.score,
        startMessageIndex: retained[0]?.index ?? startMessageIndex,
        endMessageIndex: retained.at(-1)?.index ?? endMessageIndex,
        messages: retained.map(({ message }) => message),
      });
    }
    return excerpts;
  }

  private getLatestAskAgentCompletedTurn(messages: readonly ChatMessage[]): {
    sourceMessageIds: string[];
    startMessageIndex: number;
    endMessageIndex: number;
  } | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const assistantMessage = messages[index];
      if (
        !assistantMessage ||
        assistantMessage.role !== "assistant" ||
        assistantMessage.error
      ) {
        continue;
      }
      for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
        const userMessage = messages[userIndex];
        if (userMessage?.role !== "user") continue;
        return {
          sourceMessageIds: [userMessage.id, assistantMessage.id],
          startMessageIndex: userIndex,
          endMessageIndex: index,
        };
      }
    }
    return null;
  }

  private async handleAskAgentEventsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    this.lifecycle.trackStream(res, () =>
      this.askAgentSseHub.remove(res, "dispose"),
    );
    await this.askAgentSseHub.subscribe(req, res, async (signal) => {
      const response = await this.buildAskAgentResponse();
      if (signal.aborted) throw new Error("ask_agent_sse_capture_aborted");
      return this.toAskAgentSsePublication(
        await this.askAgentController.publishSnapshot(response.snapshot),
      );
    });
  }

  private resolveModelCatalogOwnerId(requestedId?: string): string | undefined {
    if (!requestedId) return undefined;
    if (this.modelCatalogSnapshots.has(requestedId)) return requestedId;
    return this.coreOwnerRegistry
      .list()
      .find((registration) => registration.owner.instanceId === requestedId)
      ?.owner.ownerId;
  }

  private getModelCatalogSnapshot(
    requestedOwnerId?: string,
  ): BrowserGatewayPrivateModelCatalogSnapshot | null {
    const candidateOwnerId = requestedOwnerId ?? this.askAgentModelOwnerId;
    const ownerId = candidateOwnerId
      ? this.resolveModelCatalogOwnerId(candidateOwnerId)
      : this.latestModelCatalogOwnerId;
    if (!ownerId) return null;
    const snapshot = this.modelCatalogSnapshots.get(ownerId);
    if (!snapshot) return null;
    const owner = this.coreOwnerRegistry.get(snapshot.publishedByOwnerId);
    if (
      !owner ||
      owner.status !== "connected" ||
      owner.ownerGenerationId !== snapshot.publishedByOwnerGenerationId
    ) {
      return null;
    }
    return snapshot;
  }

  private applyModelCatalogForOwner(
    ownerId?: string,
  ): BrowserGatewayPrivateModelCatalogSnapshot | null {
    const requestedOwnerId = ownerId?.trim();
    const resolvedOwnerId = requestedOwnerId
      ? this.resolveModelCatalogOwnerId(requestedOwnerId)
      : this.askAgentModelOwnerId;
    if (requestedOwnerId && !resolvedOwnerId) {
      this.askAgentSessionStore.updateAvailableModels([]);
      return null;
    }
    if (resolvedOwnerId) this.askAgentModelOwnerId = resolvedOwnerId;
    const snapshot = this.getModelCatalogSnapshot(resolvedOwnerId);
    this.askAgentSessionStore.updateAvailableModels(
      snapshot
        ? snapshot.models.map((model) => ({
            id: model.id,
            displayName: model.displayName,
            provider: model.providerId,
            providerDisplayName: model.providerDisplayName,
            supportsToolUse: model.supportsToolUse,
            supportsImages: model.supportsImages,
            contextWindow: model.contextWindow,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            reasoningEfforts: model.reasoningEfforts,
            defaultReasoningEffort: model.defaultReasoningEffort,
            authenticated: model.authenticated,
            condenseThreshold: model.condenseThreshold,
          }))
        : [],
    );
    return snapshot;
  }

  private async pinAskAgentModelOwner(
    modelContext: AskAgentModelExecutionContext,
  ): Promise<void> {
    if (this.askAgentModelOwnerId === modelContext.modelOwnerId) return;
    this.askAgentModelOwnerId = modelContext.modelOwnerId;
    await this.askAgentPreferencesStore.update({
      ...this.askAgentSessionStore.getPreferencesSnapshot(),
      modelOwnerId: modelContext.modelOwnerId,
    });
  }

  private modelCatalogSnapshotAdvertises(
    snapshot: BrowserGatewayPrivateModelCatalogSnapshot,
    model: string,
    providerId: string,
  ): boolean {
    return snapshot.models.some(
      (entry) =>
        entry.id === model &&
        normalizeBrowserGatewayModelCredentialProviderId(entry.providerId) ===
          providerId,
    );
  }

  private resolvePromptProfileFromSnapshot(
    snapshot: BrowserGatewayPrivateModelCatalogSnapshot,
    model: string,
    providerId: string,
  ): Readonly<PromptProfileResolution> {
    const publishedPromptProfile = snapshot.promptProfileResolutions[model];
    return publishedPromptProfile &&
      publishedPromptProfile.modelId === model &&
      publishedPromptProfile.providerId === providerId
      ? publishedPromptProfile
      : resolvePromptProfile({ providerId, modelId: model });
  }

  private getAskAgentModelExecutionContextFromSnapshot(params: {
    snapshot: BrowserGatewayPrivateModelCatalogSnapshot;
    model: string;
    providerId: string;
    now: number;
  }): AskAgentModelExecutionContext | null {
    const { snapshot, model, providerId, now } = params;
    if (!this.modelCatalogSnapshotAdvertises(snapshot, model, providerId)) {
      return null;
    }
    const openAiCompatibleRuntimeProfile =
      snapshot.openAiCompatibleRuntimeProfiles[providerId];
    const promptProfile = this.resolvePromptProfileFromSnapshot(
      snapshot,
      model,
      providerId,
    );
    const credential = this.modelCredentialCache.getCredential({
      grantedByOwnerId: snapshot.publishedByOwnerId,
      grantedByOwnerGenerationId: snapshot.publishedByOwnerGenerationId,
      providerId,
      modelScope: BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE,
      now,
    });
    if (openAiCompatibleRuntimeProfile) {
      if (openAiCompatibleRuntimeProfile.authRequired && !credential) {
        return null;
      }
    } else if (!credential) {
      return null;
    }
    return {
      modelOwnerId: snapshot.publishedByOwnerId,
      ownerId: snapshot.publishedByOwnerId,
      ownerGenerationId: snapshot.publishedByOwnerGenerationId,
      providerId,
      model,
      promptProfile,
      credential: credential ?? undefined,
      openAiCompatibleRuntimeProfile,
    };
  }

  private getAskAgentModelExecutionContext(
    now = Date.now(),
    requestedOwnerId = this.askAgentModelOwnerId,
  ): AskAgentModelExecutionContext | null {
    const snapshot = this.getModelCatalogSnapshot(requestedOwnerId);
    const model = this.askAgentSessionStore.getModel();
    const providerId = this.askAgentSessionStore.getModelProvider();
    if (!snapshot) return null;
    if (!this.modelCatalogSnapshotAdvertises(snapshot, model, providerId)) {
      return null;
    }

    const selectedPromptProfile = this.resolvePromptProfileFromSnapshot(
      snapshot,
      model,
      providerId,
    );
    const selectedOwnerContext =
      this.getAskAgentModelExecutionContextFromSnapshot({
        snapshot,
        model,
        providerId,
        now,
      });
    if (selectedOwnerContext) return selectedOwnerContext;
    if (providerId !== BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID)
      return null;

    // Codex credentials are account-scoped rather than workspace-scoped, so a
    // connected owner may supply them without replacing the selected catalog.
    const candidateSnapshots = [...this.modelCatalogSnapshots.keys()]
      .filter((ownerId) => ownerId !== snapshot.publishedByOwnerId)
      .flatMap((ownerId) => this.getModelCatalogSnapshot(ownerId) ?? [])
      .sort(
        (left, right) =>
          right.publishedAt - left.publishedAt ||
          left.publishedByOwnerId.localeCompare(right.publishedByOwnerId),
      );
    for (const candidateSnapshot of candidateSnapshots) {
      const candidateContext =
        this.getAskAgentModelExecutionContextFromSnapshot({
          snapshot: candidateSnapshot,
          model,
          providerId,
          now,
        });
      if (candidateContext) {
        return {
          ...candidateContext,
          modelOwnerId: snapshot.publishedByOwnerId,
          promptProfile: selectedPromptProfile,
        };
      }
    }
    return null;
  }

  private getAskAgentModelCredential(now = Date.now()) {
    return this.getAskAgentModelExecutionContext(now)?.credential;
  }

  private clearAskAgentModelCredential(): void {
    const context = this.getAskAgentModelExecutionContext();
    if (!context) return;
    this.modelCredentialCache.clear({
      grantedByOwnerId: context.ownerId,
      grantedByOwnerGenerationId: context.ownerGenerationId,
      providerId: context.providerId,
    });
  }

  private getAskAgentModelCredentialStatus(
    now = Date.now(),
    requestedOwnerId = this.askAgentModelOwnerId,
  ) {
    const snapshot = this.getModelCatalogSnapshot(requestedOwnerId);
    const providerId = this.askAgentSessionStore.getModelProvider();
    if (!snapshot) {
      return {
        state: "missing" as const,
        reason:
          "Open a VS Code AgentLink window to publish model configuration.",
      };
    }
    const modelContext = this.getAskAgentModelExecutionContext(
      now,
      requestedOwnerId,
    );
    if (modelContext?.openAiCompatibleRuntimeProfile?.authRequired === false) {
      return { state: "not_required" as const, providerId };
    }
    const credentialOwner = modelContext ?? {
      ownerId: snapshot.publishedByOwnerId,
      ownerGenerationId: snapshot.publishedByOwnerGenerationId,
    };
    return this.modelCredentialCache.getStatus({
      grantedByOwnerId: credentialOwner.ownerId,
      grantedByOwnerGenerationId: credentialOwner.ownerGenerationId,
      providerId,
      modelScope: BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE,
      now,
    });
  }

  private handleAskAgentModelsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const requestedOwnerId = new URL(
      req.url ?? "/api/ask-agent/models",
      "http://localhost",
    ).searchParams
      .get("instanceId")
      ?.trim();
    const publishedCatalog = this.getModelCatalogSnapshot(requestedOwnerId);
    const models = publishedCatalog
      ? publishedCatalog.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          provider: model.providerId,
          providerDisplayName: model.providerDisplayName,
          supportsToolUse: model.supportsToolUse,
          supportsImages: model.supportsImages,
          contextWindow: model.contextWindow,
          maxInputTokens: model.maxInputTokens,
          maxOutputTokens: model.maxOutputTokens,
          reasoningEfforts: model.reasoningEfforts,
          defaultReasoningEffort: model.defaultReasoningEffort,
          authenticated: model.authenticated,
          condenseThreshold: model.condenseThreshold,
        }))
      : this.askAgentSessionStore.getFallbackModels();
    writeJson(res, 200, {
      models,
      publishedByOwnerId: publishedCatalog?.publishedByOwnerId,
      publishedByOwnerGenerationId:
        publishedCatalog?.publishedByOwnerGenerationId,
      publishedAt: publishedCatalog?.publishedAt,
      source: publishedCatalog ? "cached" : "fallback",
    });
  }

  private async handleAskAgentSlashCommandsRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    const commands = await loadAskAgentSlashCommands("ask");
    writeJson(res, 200, { commands });
  }

  private applyAskAgentMcpClientCapabilities(
    value: unknown,
    req: http.IncomingMessage,
  ): unknown {
    return applyBrowserGatewayMcpClientCapabilities(
      value,
      classifyBrowserGatewayClientOrigin(req.socket.remoteAddress),
    );
  }

  private async proxyAskAgentMcpConfigRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetPath: string,
    method: "GET" | "POST" | "DELETE",
  ): Promise<void> {
    const target = await this.getAskAgentMcpBridgeTarget();
    if (!target) {
      writeJson(res, 200, {
        ok: false,
        error: "mcp_host_unavailable",
      });
      return;
    }
    try {
      const origin = classifyBrowserGatewayClientOrigin(
        req.socket.remoteAddress,
      );
      const headers: Record<string, string> = {
        authorization: `Bearer ${target.authToken}`,
        ...buildBrowserGatewayHelperTrustHeaders(
          this.clientSharedSecret,
          origin,
        ),
      };
      let body: string | undefined;
      if (method !== "GET") {
        const parsed = (await readJsonBody(req)) as unknown;
        if (origin === "non-loopback") {
          if (method === "DELETE") {
            writeJson(res, 403, {
              error: "browser_local_process_requires_loopback",
            });
            return;
          }
          const operations =
            parsed &&
            typeof parsed === "object" &&
            "operations" in parsed &&
            Array.isArray((parsed as { operations?: unknown }).operations)
              ? (
                  parsed as {
                    operations: Array<{
                      kind?: unknown;
                      server?: unknown;
                    }>;
                  }
                ).operations
              : undefined;
          if (operations?.some((operation) => operation.kind === "remove")) {
            writeJson(res, 403, {
              error: "browser_local_process_requires_loopback",
            });
            return;
          }
          const servers = operations
            ? operations
                .filter((operation) => operation.kind === "upsert")
                .map((operation) => operation.server)
            : [
                parsed && typeof parsed === "object" && "server" in parsed
                  ? (parsed as { server?: unknown }).server
                  : undefined,
              ];
          const hasSecretWrite = servers.some(hasBrowserGatewayMcpSecretWrite);
          if (hasSecretWrite) {
            writeJson(res, 403, {
              error: "browser_secret_write_requires_loopback",
            });
            return;
          }
          const hasLocalProcessWrite = servers.some((server) => {
            const transport =
              server && typeof server === "object" && "type" in server
                ? (server as { type?: unknown }).type
                : undefined;
            return transport === undefined || transport === "stdio";
          });
          if (hasLocalProcessWrite) {
            writeJson(res, 403, {
              error: "browser_local_process_requires_loopback",
            });
            return;
          }
        }
        body = JSON.stringify(parsed ?? {});
        headers["content-type"] = "application/json";
      }
      const response = await fetch(
        `${target.url}${targetPath}`,
        body === undefined ? { method, headers } : { method, headers, body },
      );
      const responseBody = this.applyAskAgentMcpClientCapabilities(
        (await response.json()) as unknown,
        req,
      );
      writeJson(res, response.ok ? 200 : response.status, responseBody);
    } catch (err) {
      writeJson(res, 500, {
        ok: false,
        error: String(err),
      });
    }
  }

  private async handleAskAgentMcpConfigRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    await this.proxyAskAgentMcpConfigRequest(
      req,
      res,
      "/internal/ask-agent/mcp-config",
      "GET",
    );
  }

  private async handleAskAgentMcpConfigServerRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    await this.proxyAskAgentMcpConfigRequest(
      req,
      res,
      "/internal/ask-agent/mcp-config/server",
      req.method === "DELETE" ? "DELETE" : "POST",
    );
  }

  private async handleAskAgentMcpConfigOpenRawRequest(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    writeJson(res, 403, { error: "browser_raw_config_unavailable" });
  }

  private async handleAskAgentMcpStatusRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const target = await this.getAskAgentMcpBridgeTarget();
    if (!target) {
      writeJson(res, 200, {
        ok: false,
        infos: [],
        error: "mcp_host_unavailable",
      });
      return;
    }
    try {
      const response = await fetch(
        `${target.url}/internal/ask-agent/mcp-status`,
        {
          headers: { authorization: `Bearer ${target.authToken}` },
        },
      );
      const body = this.applyAskAgentMcpClientCapabilities(
        (await response.json()) as unknown,
        req,
      );
      writeJson(res, response.ok ? 200 : response.status, body);
    } catch (err) {
      writeJson(res, 500, {
        ok: false,
        infos: [],
        error: String(err),
      });
    }
  }

  private async handleAskAgentMcpRefreshRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const target = await this.getAskAgentMcpBridgeTarget();
    if (!target) {
      writeJson(res, 200, {
        ok: false,
        infos: [],
        error: "mcp_host_unavailable",
      });
      return;
    }
    try {
      const response = await fetch(
        `${target.url}/internal/ask-agent/mcp-refresh`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${target.authToken}` },
        },
      );
      const body = this.applyAskAgentMcpClientCapabilities(
        (await response.json()) as unknown,
        req,
      );
      writeJson(res, response.ok ? 200 : response.status, body);
    } catch (err) {
      writeJson(res, 500, {
        ok: false,
        infos: [],
        error: String(err),
      });
    }
  }

  private async buildAskAgentDerivedMemoryStatus(): Promise<AskAgentDerivedMemoryStatus> {
    const { sessions, chunkCount } = await this.listAskAgentDerivedSessions();
    const recentSessions = [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
      .map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt,
      }));
    const lastUpdatedAt =
      sessions.length > 0
        ? Math.max(...sessions.map((session) => session.updatedAt))
        : null;

    return {
      sessionSummaryCount: sessions.length,
      chunkSummaryCount: chunkCount,
      totalSummaryCount: sessions.length + chunkCount,
      lastUpdatedAt,
      recentSessions,
    };
  }

  private async handleAskAgentMemoryStatusRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      writeJson(res, 200, {
        ok: true,
        memory: await this.buildAskAgentDerivedMemoryStatus(),
      });
    } catch (err) {
      this.logAskAgentEvent("ask-agent.memory.status", {
        ok: false,
        error: String(err),
      });
      writeJson(res, 500, { error: "internal_error" });
    }
  }

  private async handleAskAgentMemoryClearRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { confirm?: unknown } | null;
      if (body?.confirm !== true) {
        writeJson(res, 400, {
          ok: false,
          error: "confirmation_required",
          message:
            "Confirm before clearing derived Ask Agent memory summaries.",
        });
        return;
      }

      const pendingSummarySessionIds = new Set([
        ...this.askAgentMemorySummaryTimers.keys(),
        ...this.askAgentMemorySummaryControllers.keys(),
      ]);
      for (const sessionId of pendingSummarySessionIds) {
        this.cancelAskAgentMemorySummary(sessionId);
      }
      await this.clearAskAgentDerivedSessions();
      const memory = await this.buildAskAgentDerivedMemoryStatus();
      this.logAskAgentEvent("ask-agent.memory.clear", {
        ok: true,
      });
      writeJson(res, 200, { ok: true, memory });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.memory.clear", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentAutonomousMemoryHealthRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    await this.refreshAskAgentAutonomousMemoryRuntime();
    const health = await this.askAgentAutonomousMemoryRuntime.health();
    writeJson(res, 200, {
      ok: true,
      health: sanitizeAutonomousMemoryHealth(health),
    });
  }

  private async handleAskAgentAutonomousMemoryActivityRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    await this.refreshAskAgentAutonomousMemoryRuntime();
    const health = await this.askAgentAutonomousMemoryRuntime.health();
    if (health.status === "unavailable") {
      writeJson(res, 200, {
        ok: true,
        events: [],
        health: sanitizeAutonomousMemoryHealth(health),
      });
      return;
    }
    const activity = await this.askAgentAutonomousMemoryRuntime.activity({
      scope: "global",
      limit: 50,
    });
    writeJson(res, 200, {
      ok: true,
      ...sanitizeAutonomousMemoryResult(activity),
    });
  }

  private async handleAskAgentAutonomousMemoryQueryRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const parsed = ASK_AGENT_AUTONOMOUS_MEMORY_QUERY_SCHEMA.safeParse(
        await readJsonBody(req),
      );
      if (!parsed.success) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      await this.refreshAskAgentAutonomousMemoryRuntime();
      const result = await this.askAgentAutonomousMemoryRuntime.query({
        scope: "global",
        ...parsed.data,
      });
      writeJson(res, 200, {
        ok: true,
        ...sanitizeAutonomousMemoryResult(result),
      });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.autonomous-memory.query", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 409, {
        error: invalidJson ? "invalid_json" : "memory_unavailable",
      });
    }
  }

  private async handleAskAgentAutonomousMemoryDetailRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const parsed = ASK_AGENT_AUTONOMOUS_MEMORY_DETAIL_SCHEMA.safeParse(
        await readJsonBody(req),
      );
      if (!parsed.success) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      await this.refreshAskAgentAutonomousMemoryRuntime();
      const result = await this.askAgentAutonomousMemoryRuntime.detail({
        recordId: parsed.data.recordId,
        scope: "global",
      });
      writeJson(res, 200, {
        ok: true,
        ...sanitizeAutonomousMemoryResult(result),
      });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.autonomous-memory.detail", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 409, {
        error: invalidJson ? "invalid_json" : "memory_unavailable",
      });
    }
  }

  private async handleAskAgentAutonomousMemoryManageRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const parsed = ASK_AGENT_AUTONOMOUS_MEMORY_MANAGE_SCHEMA.safeParse(
        await readJsonBody(req),
      );
      if (!parsed.success) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const { scope: _scope, nudgeId, ...validated } = parsed.data;
      const sourceEvidence = validated.source_evidence.trim();
      if (!sourceEvidence) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const input: ManageMemoryToolInput = {
        ...validated,
        scope: "global",
        source_evidence: sourceEvidence,
      };
      await this.refreshAskAgentAutonomousMemoryRuntime();
      const result = await this.askAgentAutonomousMemoryRuntime.manageAsUser(
        input,
        {
          observedAt: new Date().toISOString(),
          evidence: sourceEvidence,
        },
      );
      if (
        nudgeId &&
        ["created", "updated", "same-fact", "superseded", "contested"].includes(
          result.result.disposition,
        )
      ) {
        this.askAgentController.dismissMemoryCandidateNudge(nudgeId);
      }
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.autonomous-memory.manage", {
        ok: true,
        operation: input.operation,
        disposition: result.result.disposition,
        auditEventId: result.result.auditEventId,
        fromNudge: Boolean(nudgeId),
      });
      writeJson(res, 200, {
        ok: true,
        result: result.result,
        health: sanitizeAutonomousMemoryHealth(result.health),
        snapshot: response.snapshot,
      });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.autonomous-memory.manage", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 409, {
        error: invalidJson ? "invalid_json" : "memory_unavailable",
      });
    }
  }

  private async handleAskAgentAutonomousMemoryClearRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const parsed = ASK_AGENT_AUTONOMOUS_MEMORY_CLEAR_SCHEMA.safeParse(
        await readJsonBody(req),
      );
      if (!parsed.success) {
        writeJson(res, 400, { error: "confirmation_required" });
        return;
      }
      await this.refreshAskAgentAutonomousMemoryRuntime();
      const result = await this.askAgentAutonomousMemoryRuntime.clearScope({
        scope: "global",
        observedAt: new Date().toISOString(),
        evidence: "Browser user confirmed clearing global autonomous memory.",
      });
      writeJson(res, 200, {
        ok: true,
        ...sanitizeAutonomousMemoryResult(result),
      });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.autonomous-memory.clear", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 409, {
        error: invalidJson ? "invalid_json" : "memory_unavailable",
      });
    }
  }

  private async handleAskAgentAutonomousMemoryExportRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      await this.refreshAskAgentAutonomousMemoryRuntime();
      const result = await this.askAgentAutonomousMemoryRuntime.exportArchive({
        scope: "global",
      });
      writeJson(res, 200, {
        ok: true,
        ...sanitizeAutonomousMemoryResult(result),
      });
    } catch (err) {
      this.logAskAgentEvent("ask-agent.autonomous-memory.export", {
        ok: false,
        error: String(err),
      });
      writeJson(res, 409, { error: "memory_unavailable" });
    }
  }

  private async handleAskAgentAutonomousMemoryImportRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const parsed = ASK_AGENT_AUTONOMOUS_MEMORY_IMPORT_SCHEMA.safeParse(
        await readJsonBody(req),
      );
      if (!parsed.success) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      await this.refreshAskAgentAutonomousMemoryRuntime();
      const result = await this.askAgentAutonomousMemoryRuntime.importArchive(
        parsed.data.archive as MemoryArchiveV1,
        {
          scope: "global",
          observedAt: new Date().toISOString(),
          evidence: "Browser user imported an autonomous-memory archive.",
        },
      );
      writeJson(res, 200, {
        ok: true,
        ...sanitizeAutonomousMemoryResult(result),
      });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.autonomous-memory.import", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 409, {
        error: invalidJson ? "invalid_json" : "memory_unavailable",
      });
    }
  }

  private async handleAskAgentMemoryProposalRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayAskAgentMemoryProposalRequest | null;
      if (
        !body ||
        (body.tier !== "instructions" &&
          body.tier !== "skill" &&
          body.tier !== "command")
      ) {
        writeJson(res, 400, { error: "invalid_memory_tier" });
        return;
      }
      const nudgeId = typeof body.nudgeId === "string" ? body.nudgeId : "";
      const approval = await this.askAgentMemoryProposalBridge.propose({
        tier: body.tier,
        scope: body.scope ?? "global",
        operation: body?.operation ?? "add",
        title: typeof body?.title === "string" ? body.title : "Remember this",
        rationale:
          typeof body?.rationale === "string"
            ? body.rationale
            : "User requested a durable Ask Agent memory proposal.",
        content: typeof body?.content === "string" ? body.content : "",
        ...(typeof body?.name === "string" ? { name: body.name } : {}),
        ...(typeof body?.replaces === "string"
          ? { replaces: body.replaces }
          : {}),
      });
      if (nudgeId) {
        this.askAgentController.dismissMemoryCandidateNudge(nudgeId);
      }
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.memory.proposal", {
        ok: true,
        approvalId: approval.id,
        tier: approval.memoryTier ?? null,
        scope: approval.memoryScope ?? null,
        operation: approval.memoryOperation ?? null,
        fromNudge: Boolean(nudgeId),
      });
      writeJson(res, 200, { ok: true, approval, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.memory.proposal", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson
          ? "invalid_json"
          : err instanceof Error
            ? err.message
            : "internal_error",
      });
    }
  }

  private async handleAskAgentMemoryCandidateNudgeDismissRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { id?: unknown } | null;
      if (!body || typeof body.id !== "string") {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      this.askAgentController.dismissMemoryCandidateNudge(body.id);
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.memory.nudge.dismiss", {
        ok: true,
        nudgeId: body.id,
      });
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.memory.nudge.dismiss", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentMemoryApprovalRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as Omit<DecisionMessage, "type">;
      if (
        !body ||
        typeof body.id !== "string" ||
        typeof body.decision !== "string"
      ) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const result = await this.askAgentMemoryProposalBridge.submitDecision({
        type: "decision",
        ...body,
      });
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.memory.approval", {
        ok: true,
        status: result.status,
        tier: result.tier,
        scope: result.scope,
        operation: result.operation,
      });
      writeJson(res, 200, { ok: true, result, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.memory.approval", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson
          ? "invalid_json"
          : err instanceof Error
            ? err.message
            : "internal_error",
      });
    }
  }

  private async handleAskAgentApprovalRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as Omit<DecisionMessage, "type">;
      if (
        !body ||
        typeof body.id !== "string" ||
        typeof body.decision !== "string"
      ) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const request = this.askAgentController.submitApproval({
        type: "decision",
        ...body,
      });
      if (!request) {
        writeJson(res, 404, { error: "approval_not_found" });
        return;
      }
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.approval", {
        ok: true,
        approvalId: body.id,
        kind: request.kind,
        decision: body.decision,
      });
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.approval", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentReadGrantsRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    writeJson(res, 200, {
      ok: true,
      grants: this.askAgentSessionStore.getReadGrants(),
    });
  }

  private async handleAskAgentReadGrantAddRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as {
        path?: unknown;
        confirm?: unknown;
      } | null;
      const requestedPath =
        typeof body?.path === "string" ? body.path.trim() : "";
      if (!requestedPath || body?.confirm !== true) {
        writeJson(res, 400, {
          ok: false,
          error: "confirmation_required",
          message:
            "Confirm a local file or directory path before granting Ask Agent read access.",
        });
        return;
      }
      const resolvedPath = path.resolve(requestedPath);
      const stat = await fs.stat(resolvedPath).catch(() => null);
      if (!stat || (!stat.isFile() && !stat.isDirectory())) {
        writeJson(res, 404, { ok: false, error: "path_not_found" });
        return;
      }
      const realPath = await fs.realpath(resolvedPath);
      const grant = {
        id: `ask-agent-read-grant-${randomUUID()}`,
        createdAt: Date.now(),
        rootPath: realPath,
        label: path.basename(realPath) || realPath,
        kind: stat.isDirectory() ? ("directory" as const) : ("file" as const),
      };
      const grants = this.askAgentSessionStore.addReadGrant(grant);
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.read-grant.add", {
        ok: true,
        grantId: grant.id,
        kind: grant.kind,
      });
      writeJson(res, 200, { ok: true, grants, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentReadGrantRevokeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { id?: unknown } | null;
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!id || !this.askAgentSessionStore.removeReadGrant(id)) {
        writeJson(res, 404, { ok: false, error: "read_grant_not_found" });
        return;
      }
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.read-grant.revoke", {
        ok: true,
        grantId: id,
      });
      writeJson(res, 200, {
        ok: true,
        grants: this.askAgentSessionStore.getReadGrants(),
        snapshot: response.snapshot,
      });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentProjectHandoffTargetsRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      writeJson(res, 200, {
        ok: true,
        targets: await this.getAskAgentProjectHandoffTargets(),
      });
    } catch (err) {
      this.logAskAgentEvent("ask-agent.project-handoff.targets", {
        ok: false,
        error: String(err),
      });
      writeJson(res, 500, { error: "internal_error" });
    }
  }

  private async handleAskAgentProjectHandoffProposeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as {
        targetInstanceId?: unknown;
        instruction?: unknown;
        mode?: unknown;
      } | null;
      const targetInstanceId =
        typeof body?.targetInstanceId === "string"
          ? body.targetInstanceId.trim()
          : "";
      const instruction =
        typeof body?.instruction === "string" ? body.instruction.trim() : "";
      const mode = typeof body?.mode === "string" ? body.mode.trim() : "code";
      if (!targetInstanceId || !instruction) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const targets = await this.getAskAgentProjectHandoffTargets();
      const target = targets.find(
        (candidate) => candidate.instanceId === targetInstanceId,
      );
      if (!target) {
        writeJson(res, 404, { error: "target_instance_not_available" });
        return;
      }
      const now = Date.now();
      const handoff = this.askAgentSessionStore.proposeProjectHandoff({
        id: `ask-agent-project-handoff-${randomUUID()}`,
        sessionId: this.askAgentSessionStore.getActiveSessionId(),
        createdAt: now,
        targetInstanceId: target.instanceId,
        targetWorkspaceName: target.workspaceName,
        targetWorkspacePath: target.workspacePath,
        mode: mode || "code",
        instruction,
      });
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.project-handoff.propose", {
        ok: true,
        handoffId: handoff.id,
        targetInstanceId: target.instanceId,
        instructionChars: instruction.length,
        mode: handoff.mode,
      });
      writeJson(res, 200, { ok: true, handoff, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.project-handoff.propose", {
        ok: false,
        error: invalidJson ? "invalid_json" : String(err),
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentProjectHandoffCancelRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { id?: unknown } | null;
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!id || !this.askAgentSessionStore.cancelProjectHandoff(id)) {
        writeJson(res, 404, { error: "project_handoff_not_found" });
        return;
      }
      const response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.project-handoff.cancel", {
        ok: true,
        handoffId: id,
      });
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentProjectHandoffApproveRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { id?: unknown } | null;
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      const handoff = id
        ? this.askAgentSessionStore.markProjectHandoffLaunching(id)
        : null;
      if (!handoff || handoff.status !== "launching") {
        writeJson(res, 404, { error: "project_handoff_not_found" });
        return;
      }

      let response = await this.buildAskAgentResponse();
      await this.publishAskAgentSnapshot(response.snapshot);
      try {
        const result = await this.launchAskAgentProjectHandoff(handoff);
        this.askAgentSessionStore.completeProjectHandoff(handoff.id);
        response = await this.buildAskAgentResponse();
        await this.publishAskAgentSnapshot(response.snapshot);
        this.logAskAgentEvent("ask-agent.project-handoff.approve", {
          ok: true,
          handoffId: handoff.id,
          targetInstanceId: handoff.targetInstanceId,
          targetSessionId: result.sessionId,
        });
        writeJson(res, 200, {
          ok: true,
          result,
          snapshot: response.snapshot,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.askAgentSessionStore.failProjectHandoff(handoff.id, error);
        response = await this.buildAskAgentResponse();
        await this.publishAskAgentSnapshot(response.snapshot);
        this.logAskAgentEvent("ask-agent.project-handoff.approve", {
          ok: false,
          handoffId: handoff.id,
          targetInstanceId: handoff.targetInstanceId,
          error,
        });
        writeJson(res, 502, {
          ok: false,
          error: "project_handoff_launch_failed",
          message: error,
          snapshot: response.snapshot,
        });
      }
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async getAskAgentProjectHandoffTargets(): Promise<
    AskAgentProjectHandoffTarget[]
  > {
    const instances = await listHealthyBrowserGatewayInstances();
    const enriched = await this.buildInstanceListItems(instances);
    return enriched.map((instance) => ({
      instanceId: instance.instanceId,
      workspaceName: instance.workspaceName,
      workspacePath: instance.workspacePath,
      url: instance.url,
      ...(instance.status ? { status: instance.status } : {}),
    }));
  }

  private async launchAskAgentProjectHandoff(
    handoff: BrowserGatewayAskAgentProjectHandoff,
  ): Promise<{ sessionId?: string }> {
    const instances = await listHealthyBrowserGatewayInstances();
    const target = instances.find(
      (instance) => instance.instanceId === handoff.targetInstanceId,
    );
    if (!target) {
      throw new Error("target_instance_not_available");
    }

    const newSessionResponse = await fetch(`${target.url}/api/session/new`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: handoff.mode }),
    });
    if (!newSessionResponse.ok) {
      throw new Error(
        `target_session_create_failed:${newSessionResponse.status}`,
      );
    }
    const newSessionBody = (await newSessionResponse
      .json()
      .catch(() => ({}))) as {
      snapshot?: {
        session?: {
          foreground?: { sessionId?: unknown } | null;
        };
      };
    };
    const sessionId =
      typeof newSessionBody.snapshot?.session?.foreground?.sessionId ===
      "string"
        ? newSessionBody.snapshot.session.foreground.sessionId
        : undefined;

    const sendResponse = await fetch(`${target.url}/api/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: handoff.instruction,
        ...(sessionId ? { sessionId } : {}),
      }),
    });
    if (!sendResponse.ok) {
      throw new Error(`target_send_failed:${sendResponse.status}`);
    }
    return { sessionId };
  }

  private async handleAskAgentUiLogRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as {
        event?: unknown;
        fields?: unknown;
      } | null;
      const event = typeof body?.event === "string" ? body.event.trim() : "";
      if (!event) {
        writeJson(res, 400, { error: "invalid_event" });
        return;
      }
      const fields =
        body?.fields && typeof body.fields === "object"
          ? this.sanitizeAskAgentLogFields(
              body.fields as Record<string, unknown>,
            )
          : {};
      this.logAskAgentEvent(`browser.${event}`, fields);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private sanitizeAskAgentLogFields(
    fields: Record<string, unknown>,
  ): Record<string, string | number | boolean | null> {
    const sanitized: Record<string, string | number | boolean | null> = {};
    const blockedKeys = new Set([
      "text",
      "prompt",
      "content",
      "message",
      "input",
      "body",
      "bearerToken",
      "token",
      "authorization",
    ]);
    for (const [key, value] of Object.entries(fields).slice(
      0,
      ASK_AGENT_LOG_FIELD_LIMIT,
    )) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) continue;
      if (blockedKeys.has(key)) continue;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        sanitized[key] =
          typeof value === "string" && value.length > 256
            ? `${value.slice(0, 256)}…`
            : value;
      }
    }
    return sanitized;
  }

  private logAskAgentEvent(
    event: string,
    fields: Record<string, string | number | boolean | null | undefined> = {},
  ): void {
    const entry = {
      ts: new Date().toISOString(),
      event,
      pid: process.pid,
      ...fields,
    };
    try {
      fsSync.mkdirSync(path.dirname(this.askAgentLogPath), {
        recursive: true,
      });
      fsSync.appendFileSync(
        this.askAgentLogPath,
        `${JSON.stringify(entry)}\n`,
        "utf-8",
      );
    } catch (err) {
      logHelper(
        `ask-agent log write failed error=${JSON.stringify(String(err))}`,
      );
    }
  }

  private async handleAskAgentModelRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as {
        model?: unknown;
        instanceId?: unknown;
      } | null;
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      const requestedOwnerId =
        typeof body?.instanceId === "string" ? body.instanceId.trim() : "";
      this.applyModelCatalogForOwner(requestedOwnerId || undefined);
      if (!model || !this.askAgentSessionStore.setModel(model)) {
        this.logAskAgentEvent("ask-agent.model", {
          model: model || null,
          ok: false,
          error: "invalid_model",
        });
        writeJson(res, 400, { error: "invalid_model" });
        return;
      }
      await this.askAgentPreferencesStore.update({
        ...this.askAgentSessionStore.getPreferencesSnapshot(),
        modelOwnerId: this.askAgentModelOwnerId,
      });
      logHelper(`ask-agent model selected model=${model}`);
      this.logAskAgentEvent("ask-agent.model", { model, ok: true });
      const now = Date.now();
      const response = this.buildAskAgentSnapshotResponse(
        now,
        await this.resolveInitialTheme(null),
      );
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.model", {
        ok: false,
        error: invalidJson ? "invalid_json" : "internal_error",
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleAskAgentThinkingRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as { effort?: unknown } | null;
      const effort = typeof body?.effort === "string" ? body.effort.trim() : "";
      if (
        !isCoreReasoningEffort(effort) ||
        !this.askAgentSessionStore.setReasoningEffort(effort)
      ) {
        this.logAskAgentEvent("ask-agent.thinking", {
          effort: effort || null,
          ok: false,
          error: "invalid_reasoning_effort",
        });
        writeJson(res, 400, { error: "invalid_reasoning_effort" });
        return;
      }
      await this.askAgentPreferencesStore.update(
        this.askAgentSessionStore.getPreferencesSnapshot(),
      );
      logHelper(`ask-agent reasoning selected effort=${effort}`);
      this.logAskAgentEvent("ask-agent.thinking", { effort, ok: true });
      const now = Date.now();
      const response = this.buildAskAgentSnapshotResponse(
        now,
        await this.resolveInitialTheme(null),
      );
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.thinking", {
        ok: false,
        error: invalidJson ? "invalid_json" : "internal_error",
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async runAskAgentModelTurn(params: {
    modelContext: AskAgentModelExecutionContext;
    assistantMessageId: string;
    transcriptMessages: ChatMessage[];
    memoryContext?: string;
    memoryDisclosure?: ChatMessage["memoryDisclosure"];
    initialToolMessages?: readonly CoreModelMessage[];
    theme: BrowserGatewayThemeSnapshot;
    signal: AbortSignal;
  }): Promise<AskAgentToolLoopResult> {
    const completeWithToolCalls =
      this.askAgentModelClient.completeWithToolCalls?.bind(
        this.askAgentModelClient,
      );
    const buildTurnSnapshot = () =>
      this.askAgentController.projectState({
        now: Date.now(),
        theme: params.theme,
        modelCredentialStatus: this.getAskAgentModelCredentialStatus(
          Date.now(),
          params.modelContext.ownerId,
        ),
        approval: this.askAgentController.getPendingApproval(),
        memoryCandidateNudge: this.askAgentController.getMemoryCandidateNudge(),
      }).snapshot;
    const scheduleTurnSnapshot = () => {
      void this.askAgentController
        .scheduleProjectedSnapshot(buildTurnSnapshot)
        .catch((error) => {
          logHelper(`ask-agent scheduled snapshot failed: ${error}`);
        });
    };
    const publishTurnSnapshot = async () => {
      await this.askAgentController.publishProjectedSnapshot(buildTurnSnapshot);
    };

    const preparedWebAccess = await this.prepareAskAgentWebAccess(
      params.modelContext,
      params.signal,
    );
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([
      ...ASK_AGENT_SAFE_PROJECTLESS_TOOLS,
      ...preparedWebAccess.tools,
      ...ASK_AGENT_NATIVE_DISCLOSURE_BRIDGE_TOOLS,
    ]);
    const modelTranscriptMessages =
      this.askAgentSessionStore.getModelTranscriptMessages(
        params.assistantMessageId,
      );

    if (!completeWithToolCalls) {
      const assistantText = await this.askAgentModelClient.complete({
        credential: params.modelContext.credential,
        providerId: params.modelContext.providerId,
        openAiCompatibleRuntimeProfile:
          params.modelContext.openAiCompatibleRuntimeProfile,
        model: params.modelContext.model,
        promptProfile: params.modelContext.promptProfile.profile,
        reasoningEffort: this.askAgentSessionStore.getReasoningEffort(),
        messages: [],
        memoryContext: params.memoryContext,
        iterationMessages: modelTranscriptMessages,
        signal: params.signal,
        onDelta: (delta) => {
          if (this.streamingMetrics.enabled) {
            this.streamingMetrics.record({
              type: "delta",
              surface: "ask-agent-helper",
              kind: "text",
              chars: delta.length,
            });
          }
          this.askAgentController.appendAssistantDelta(
            params.assistantMessageId,
            delta,
          );
          scheduleTurnSnapshot();
        },
      });
      if (assistantText) {
        return this.finishAskAgentSuccess(params, assistantText);
      }
      this.finishAskAgentEmptyResponse(params.assistantMessageId);
      return { outcome: "model_empty", assistantText: "" };
    }

    return runAgentToolLoop<AskAgentToolLoopResult, AskAgentToolLoopOutcome>({
      initialToolMessages: params.initialToolMessages,
      callModel: async ({ iterationMessages, toolMessages, onText }) => {
        const result = await completeWithToolCalls({
          credential: params.modelContext.credential,
          providerId: params.modelContext.providerId,
          openAiCompatibleRuntimeProfile:
            params.modelContext.openAiCompatibleRuntimeProfile,
          model: params.modelContext.model,
          promptProfile: params.modelContext.promptProfile.profile,
          reasoningEffort: this.askAgentSessionStore.getReasoningEffort(),
          messages: [],
          memoryContext: params.memoryContext,
          iterationMessages: [...modelTranscriptMessages, ...iterationMessages],
          toolMessages,
          tools: nativeToolDisclosure.inlineTools,
          signal: params.signal,
          onDelta: (delta) => {
            onText(delta);
            if (this.streamingMetrics.enabled) {
              this.streamingMetrics.record({
                type: "delta",
                surface: "ask-agent-helper",
                kind: "text",
                chars: delta.length,
              });
            }
            this.askAgentController.appendAssistantDelta(
              params.assistantMessageId,
              delta,
            );
            scheduleTurnSnapshot();
          },
        });
        return {
          text: result.text,
          toolCalls: result.toolCalls,
          assistantMessage: result.assistantMessage,
          stopReason: result.stopReason,
        };
      },
      onIterationMessagesComplete: (messages) => {
        if (
          messages.some(
            (message) => message.role === "assistant" && message.providerReplay,
          )
        ) {
          this.askAgentSessionStore.appendPrivateModelTurn(
            params.assistantMessageId,
            messages,
          );
        }
      },
      isParallelSafe: (providerCall) => {
        const { canonicalCall, resolutionError } = this.resolveAskAgentToolCall(
          providerCall,
          nativeToolDisclosure,
        );
        if (resolutionError) return false;
        if (ASK_AGENT_PARALLEL_SAFE_TOOL_NAMES.has(canonicalCall.name)) {
          return true;
        }
        if (
          preparedWebAccess.parallelSafeMcpToolNames.includes(
            canonicalCall.name,
          )
        ) {
          return true;
        }
        if (canonicalCall.name !== "call_mcp_tool") return false;
        const serverName =
          typeof canonicalCall.input.server === "string"
            ? canonicalCall.input.server.trim()
            : "";
        return preparedWebAccess.parallelSafeMcpServerNames.includes(
          serverName,
        );
      },
      runTool: async (providerCall) => {
        const toolStartedAt = Date.now();
        const resolved = this.resolveAskAgentToolCall(
          providerCall,
          nativeToolDisclosure,
        );
        const { canonicalCall } = resolved;
        this.recordAskAgentSemanticDelta();
        this.askAgentController.startAssistantToolCall({
          messageId: params.assistantMessageId,
          toolCallId: canonicalCall.id,
          toolName: canonicalCall.name,
          input: canonicalCall.input,
        });
        await publishTurnSnapshot();
        const executed = resolved.resolutionError
          ? this.buildAskAgentToolResolutionError(
              canonicalCall,
              resolved.resolutionError,
            )
          : canonicalCall.name === "find_native_tools"
            ? this.executeAskAgentNativeToolDiscovery(
                canonicalCall,
                nativeToolDisclosure,
              )
            : await this.executeAskAgentSafeProjectlessTool(
                canonicalCall,
                preparedWebAccess,
                params.modelContext.credential,
                params.modelContext.model,
                params.modelContext.ownerId,
                params.signal,
              );
        this.recordAskAgentSemanticDelta();
        this.askAgentController.completeAssistantToolCall({
          messageId: params.assistantMessageId,
          toolCallId: canonicalCall.id,
          toolName: canonicalCall.name,
          input: canonicalCall.input,
          result: executed.modelResult ?? executed.content,
          resultImages: executed.resultImages,
          durationMs: Date.now() - toolStartedAt,
        });
        await publishTurnSnapshot();
        return {
          toolMessage: this.rebindAskAgentToolResultMessage(
            executed.toolMessage,
            providerCall,
          ),
          stop: executed.stop,
          content: executed.content,
          outcome: executed.outcome,
        };
      },
      finishSuccess: (text, outcome) =>
        this.finishAskAgentSuccess(params, text, outcome),
      finishEmpty: () => {
        this.finishAskAgentEmptyResponse(params.assistantMessageId);
        return { outcome: "model_empty", assistantText: "" };
      },
    });
  }

  private resolveAskAgentToolCall(
    providerCall: BrowserGatewayAskAgentToolCall,
    disclosure: NativeToolDisclosureSnapshot,
  ): ResolvedAskAgentToolCall {
    if (providerCall.name === "find_native_tools") {
      const parsed = z
        .object(findNativeToolsSchema)
        .strict()
        .safeParse(providerCall.input);
      return parsed.success
        ? {
            providerCall,
            canonicalCall: { ...providerCall, input: parsed.data },
          }
        : {
            providerCall,
            canonicalCall: providerCall,
            resolutionError: {
              message: "Invalid find_native_tools input",
              status: "invalid_native_discovery_input",
              issues: parsed.error.issues,
            },
          };
    }

    if (providerCall.name === "call_native_tool") {
      const parsedBridge = z
        .object(callNativeToolSchema)
        .strict()
        .safeParse(providerCall.input);
      if (!parsedBridge.success) {
        return {
          providerCall,
          canonicalCall: providerCall,
          resolutionError: {
            message: "Invalid call_native_tool input",
            status: "invalid_bridge_input",
            issues: parsedBridge.error.issues,
          },
        };
      }
      const requestedCanonicalCall = {
        id: providerCall.id,
        name: parsedBridge.data.name,
        input: parsedBridge.data.input,
      };
      const target = getDeferredNativeTool(disclosure, parsedBridge.data.name);
      if (!target) {
        return {
          providerCall,
          canonicalCall: requestedCanonicalCall,
          resolutionError: {
            message: `Native tool '${parsedBridge.data.name}' was not available in the deferred catalog for this Browser Ask Agent turn`,
            status: "native_tool_not_available",
          },
        };
      }
      const parsedTarget = parseAskAgentDeferredNativeToolInput(
        target.name,
        parsedBridge.data.input,
      );
      if (!parsedTarget.success) {
        return {
          providerCall,
          canonicalCall: requestedCanonicalCall,
          resolutionError: {
            message:
              parsedTarget.status === "native_tool_not_invocable"
                ? `Native tool '${target.name}' has no Browser Ask Agent validator`
                : `Invalid input for native tool '${target.name}'`,
            status: parsedTarget.status,
            issues: parsedTarget.issues,
          },
        };
      }
      return {
        providerCall,
        canonicalCall: {
          id: providerCall.id,
          name: target.name,
          input: parsedTarget.data,
        },
      };
    }

    if (getDeferredNativeTool(disclosure, providerCall.name)) {
      return {
        providerCall,
        canonicalCall: providerCall,
        resolutionError: {
          message: `Native tool '${providerCall.name}' must be invoked through call_native_tool`,
          status: "direct_deferred_native_tool_call",
        },
      };
    }

    const directTool = disclosure.inlineTools.find(
      (tool) => tool.name === providerCall.name,
    );
    if (!directTool) {
      return {
        providerCall,
        canonicalCall: providerCall,
        resolutionError: {
          message: `Native tool '${providerCall.name}' was not available in the authorized Browser Ask Agent catalog`,
          status: "native_tool_not_available",
        },
      };
    }
    return { providerCall, canonicalCall: providerCall };
  }

  private buildAskAgentToolResolutionError(
    toolCall: BrowserGatewayAskAgentToolCall,
    error: NonNullable<ResolvedAskAgentToolCall["resolutionError"]>,
  ): AskAgentToolExecutionResult {
    const content = JSON.stringify({
      error: error.message,
      status: error.status,
      tool: toolCall.name,
      ...(error.issues ? { issues: error.issues } : {}),
    });
    this.logAskAgentEvent("ask-agent.tool.denied", {
      toolName: toolCall.name,
      ok: false,
      error: error.status,
    });
    const stop =
      error.status === "native_tool_not_available" ||
      error.status === "direct_deferred_native_tool_call";
    return {
      content,
      stop,
      ...(stop ? { outcome: "model_final" as const } : {}),
      toolMessage: this.buildAskAgentToolResultMessage(toolCall, content, true),
    };
  }

  private executeAskAgentNativeToolDiscovery(
    toolCall: BrowserGatewayAskAgentToolCall,
    disclosure: NativeToolDisclosureSnapshot,
  ): AskAgentToolExecutionResult {
    const input = toolCall.input as {
      query?: string;
      limit?: number;
      offset?: number;
      include_schemas?: boolean;
      schema_limit?: number;
    };
    const content = JSON.stringify(
      discoverNativeTools(disclosure, {
        query: input.query,
        limit: input.limit,
        offset: input.offset,
        includeSchemas: input.include_schemas,
        schemaLimit: input.schema_limit,
      }),
    );
    this.logAskAgentEvent("ask-agent.tool.find_native_tools", {
      ok: true,
      deferredTools: disclosure.deferredTools.length,
    });
    return {
      content,
      stop: false,
      toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
    };
  }

  private rebindAskAgentToolResultMessage(
    toolMessage: CoreModelMessage | undefined,
    providerCall: BrowserGatewayAskAgentToolCall,
  ): CoreModelMessage | undefined {
    if (!toolMessage || !Array.isArray(toolMessage.content)) return toolMessage;
    return {
      ...toolMessage,
      content: toolMessage.content.map((block) =>
        block.type === "tool_use" && block.id === providerCall.id
          ? {
              ...block,
              name: providerCall.name,
              input: providerCall.input,
            }
          : block,
      ),
    };
  }

  private finishAskAgentSuccess(
    params: {
      assistantMessageId: string;
      memoryDisclosure?: ChatMessage["memoryDisclosure"];
    },
    assistantText: string,
    outcome: AskAgentToolLoopOutcome = "model_success",
  ): AskAgentToolLoopResult {
    this.askAgentController.finishAssistantSuccess({
      messageId: params.assistantMessageId,
      text: assistantText,
      memoryDisclosure: params.memoryDisclosure,
    });
    return { outcome, assistantText };
  }

  private finishAskAgentEmptyResponse(messageId: string): void {
    this.askAgentController.finishAssistantEmpty({
      messageId,
      text: ASK_AGENT_EMPTY_MODEL_ERROR,
      code: "model_empty",
    });
  }

  private async prepareAskAgentWebAccess(
    modelContext: AskAgentModelExecutionContext,
    signal: AbortSignal,
  ): Promise<PreparedAskAgentWebAccess> {
    const target = await this.getAskAgentMcpBridgeTarget();
    const [remotePolicy, mcpCatalog] = await Promise.all([
      this.getAskAgentWebPolicy(target, signal),
      this.getAskAgentMcpTools(target, signal),
    ]);
    const preferences = await this.askAgentPreferencesStore.read();
    const cachedPolicy = preferences.webPolicy;
    const settings = normalizeCoreWebAccessSettings(
      remotePolicy?.settings ?? cachedPolicy?.settings,
    );

    if (remotePolicy && target) {
      const nextCache: BrowserGatewayAskAgentWebPolicyCache = {
        settings,
        sourceInstanceId: target.instanceId,
        sourceRevision: remotePolicy.revision,
        updatedAt: Date.now(),
      };
      await this.askAgentPreferencesStore.update({ webPolicy: nextCache });
    }

    const providerId = normalizeBrowserGatewayModelCredentialProviderId(
      modelContext.providerId,
    );
    const providerCapabilities =
      providerId === "openai-codex" && modelContext.credential
        ? getCodexModelCapabilities(
            modelContext.model,
            modelContext.credential.method,
          ).hostedWeb
        : providerId === "anthropic" && modelContext.credential
          ? ANTHROPIC_HOSTED_WEB_CAPABILITIES
          : undefined;
    const policy = resolveCoreWebAccessPolicy({
      settings,
      providerCapabilities,
    });

    const nativeTools = modelContext.credential
      ? policy.enabledKinds.map(
          (kind) => CORE_NATIVE_WEB_TOOL_DEFINITIONS[kind],
        )
      : [];
    const tools = [...mcpCatalog.tools, ...nativeTools];
    return Object.freeze({
      target,
      policy: freezeAskAgentValue(policy),
      tools: freezeAskAgentValue(tools),
      parallelSafeMcpToolNames: freezeAskAgentValue(
        mcpCatalog.parallelSafeToolNames,
      ),
      parallelSafeMcpServerNames: freezeAskAgentValue(
        mcpCatalog.parallelSafeServerNames,
      ),
    });
  }

  private async getAskAgentMcpBridgeTarget(): Promise<BrowserGatewayInstanceRecord | null> {
    const instances = await listHealthyBrowserGatewayInstances();
    return this.selectInstance(instances, undefined);
  }

  private async getAskAgentWebPolicy(
    target: BrowserGatewayInstanceRecord | null,
    signal: AbortSignal,
  ): Promise<{ settings: CoreWebAccessSettings; revision?: string } | null> {
    if (!target) return null;
    try {
      const response = await fetch(
        `${target.url}/internal/ask-agent/web-policy`,
        {
          headers: { authorization: `Bearer ${target.authToken}` },
          signal,
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        ok?: boolean;
        settings?: Partial<CoreWebAccessSettings>;
        revision?: string;
      };
      if (!body.ok || !body.settings) return null;
      return {
        settings: normalizeCoreWebAccessSettings(body.settings),
        revision: typeof body.revision === "string" ? body.revision : undefined,
      };
    } catch (err) {
      this.logAskAgentEvent("ask-agent.web.policy_failed", {
        ok: false,
        targetInstanceId: target.instanceId,
        error: String(err),
      });
      return null;
    }
  }

  private async getAskAgentMcpTools(
    target: BrowserGatewayInstanceRecord | null,
    signal: AbortSignal,
  ): Promise<{
    tools: CoreModelToolDefinition[];
    parallelSafeToolNames: string[];
    parallelSafeServerNames: string[];
  }> {
    const empty = {
      tools: [],
      parallelSafeToolNames: [],
      parallelSafeServerNames: [],
    };
    if (!target) return empty;
    try {
      const response = await fetch(
        `${target.url}/internal/ask-agent/mcp-tools`,
        {
          headers: { authorization: `Bearer ${target.authToken}` },
          signal,
        },
      );
      if (!response.ok) return empty;
      const body = (await response.json()) as {
        ok?: boolean;
        tools?: CoreModelToolDefinition[];
        parallelSafeToolNames?: string[];
        parallelSafeServerNames?: string[];
      };
      return {
        tools: Array.isArray(body.tools) ? body.tools : [],
        parallelSafeToolNames: Array.isArray(body.parallelSafeToolNames)
          ? body.parallelSafeToolNames.filter(
              (name): name is string => typeof name === "string",
            )
          : [],
        parallelSafeServerNames: Array.isArray(body.parallelSafeServerNames)
          ? body.parallelSafeServerNames.filter(
              (name): name is string => typeof name === "string",
            )
          : [],
      };
    } catch (err) {
      this.logAskAgentEvent("ask-agent.tool.mcp_tools_failed", {
        ok: false,
        error: String(err),
      });
      return empty;
    }
  }

  private async executeAskAgentMcpTool(
    toolCall: BrowserGatewayAskAgentToolCall,
    target: BrowserGatewayInstanceRecord | null,
    signal: AbortSignal,
  ): Promise<AskAgentToolExecutionResult> {
    if (!target) {
      const content = JSON.stringify({ error: "MCP hub not available" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    try {
      const response = await fetch(
        `${target.url}/internal/ask-agent/mcp-tool`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${target.authToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: toolCall.name,
            input: toolCall.input,
            sessionId: this.askAgentSessionStore.getActiveSessionId(),
          }),
          signal,
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        result?: ToolResult;
        error?: string;
      };
      const result = body.result;
      const media = askAgentMediaFromToolResult(result);
      const content =
        media.content ||
        (media.resultImages.length > 0
          ? `[${media.resultImages.length} image${media.resultImages.length === 1 ? "" : "s"}]`
          : JSON.stringify({ error: body.error ?? "mcp_tool_failed" }));
      const modelContent =
        Array.isArray(media.modelContent) && !media.content
          ? [{ type: "text" as const, text: content }, ...media.modelContent]
          : media.modelContent || content;
      this.logAskAgentEvent("ask-agent.tool.mcp", {
        ok: Boolean(response.ok && body.ok),
        toolName: toolCall.name,
        targetInstanceId: target.instanceId,
      });
      return {
        content,
        modelContent,
        ...(media.resultImages.length > 0
          ? { resultImages: media.resultImages }
          : {}),
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          !(response.ok && body.ok) || result?.isError === true,
          modelContent,
        ),
      };
    } catch (err) {
      const content = JSON.stringify({ error: String(err) });
      this.logAskAgentEvent("ask-agent.tool.mcp", {
        ok: false,
        toolName: toolCall.name,
        error: String(err),
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
  }

  private normalizeAskAgentImageInput(input: Record<string, unknown>): {
    prompt: string;
    count: number;
    size?: string;
    timeoutMs: number;
  } {
    for (const forbidden of [
      "output_path",
      "reference_image_paths",
      "reference_image_ids",
      "use_recent_images",
    ]) {
      if (Object.hasOwn(input, forbidden)) {
        throw new Error(
          `Ask Agent generate_image does not support ${forbidden}; browser Ask Agent image generation is display-only and cannot read or write local files.`,
        );
      }
    }
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new Error("prompt is required");
    const numericCount = Number(input.count ?? 1);
    const count =
      Number.isFinite(numericCount) && numericCount >= 1
        ? Math.min(Math.floor(numericCount), CODEX_IMAGE_GENERATION_MAX_COUNT)
        : 1;
    const size =
      typeof input.size === "string" && input.size.trim()
        ? input.size.trim()
        : undefined;
    const numericTimeoutSeconds = Number(
      input.timeout_seconds ?? CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS / 1000,
    );
    const timeoutMs =
      Number.isFinite(numericTimeoutSeconds) && numericTimeoutSeconds > 0
        ? Math.min(
            Math.floor(numericTimeoutSeconds * 1000),
            CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS,
          )
        : CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS;
    return { prompt, count, size, timeoutMs };
  }

  private executeAskAgentPresentImagesTool(
    toolCall: BrowserGatewayAskAgentToolCall,
  ): AskAgentToolExecutionResult {
    try {
      const result = handlePresentImages(toolCall.input, () =>
        this.askAgentSessionStore.getSessionImages(),
      );
      const media = askAgentMediaFromToolResult(result);
      this.logAskAgentEvent("ask-agent.tool.present_images", {
        ok: true,
        imageCount: media.resultImages.length,
      });
      return {
        content: media.content,
        modelContent: media.modelContent,
        resultImages: media.resultImages,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          media.content,
          false,
          media.modelContent,
        ),
      };
    } catch (error) {
      const content = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
      this.logAskAgentEvent("ask-agent.tool.present_images", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
  }

  private async requestAskAgentGenerateImageApproval(params: {
    prompt: string;
    count: number;
    size?: string;
    billing: string;
    signal: AbortSignal;
  }): Promise<DecisionMessage> {
    if (this.askAgentMemoryProposalBridge.getPendingApproval()) {
      throw new Error("An Ask Agent memory approval is already pending");
    }
    if (this.askAgentController.getPendingApproval()) {
      throw new Error("An Ask Agent image approval is already pending");
    }
    const id = `ask-agent-generate-image-${randomUUID()}`;
    const detail = [
      `Generation prompt:\n${params.prompt}`,
      `Images: ${params.count}`,
      params.size ? `Requested size: ${params.size}` : undefined,
      `Billing: ${params.billing}`,
      "Output: Ask Agent chat display only (no files will be written)",
      "",
      "Image generation consumes ChatGPT/Codex image quota or OpenAI API-key billing before images are returned to chat.",
      "Generate for Session authorizes later display-only generate_image calls in this Ask Agent chat.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const request: ApprovalRequest = {
      kind: "write",
      id,
      filePath: `Generate ${params.count} image${params.count === 1 ? "" : "s"}?`,
      writeOperation: "modify",
      detail,
      writeChoices: [
        { label: "Generate", value: "accept", isPrimary: true },
        { label: "Generate for Session", value: "accept-session" },
        { label: "Deny", value: "reject", isDanger: true },
      ],
    };
    const decisionPromise = this.askAgentController.requestApproval(
      request,
      params.signal,
    );
    const response = await this.buildAskAgentResponse();
    await this.publishAskAgentSnapshot(response.snapshot);
    return await decisionPromise;
  }

  private async executeAskAgentGenerateImageTool(
    toolCall: BrowserGatewayAskAgentToolCall,
    _target: BrowserGatewayInstanceRecord | null,
    modelOwnerId: string,
    signal: AbortSignal,
  ): Promise<AskAgentToolExecutionResult> {
    const generatedImages: CodexGeneratedImage[] = [];
    try {
      const input = this.normalizeAskAgentImageInput(toolCall.input);
      const snapshot = this.getModelCatalogSnapshot(modelOwnerId);
      const credential = snapshot
        ? this.modelCredentialCache.getCredential({
            grantedByOwnerId: snapshot.publishedByOwnerId,
            grantedByOwnerGenerationId: snapshot.publishedByOwnerGenerationId,
            providerId: BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID,
            modelScope: BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE,
            now: Date.now(),
          })
        : null;
      if (!credential) {
        throw new Error(
          "generate_image requires refreshed Codex/OpenAI credentials from a connected VS Code AgentLink instance",
        );
      }
      const billing =
        credential.method === "oauth"
          ? `ChatGPT/Codex OAuth quota (${credential.accountLabel ?? "active account"})`
          : "OpenAI API key billing";
      const approval = this.askAgentSessionStore.isGenerateImageApproved()
        ? ({ decision: "accept" } as DecisionMessage)
        : await this.requestAskAgentGenerateImageApproval({
            ...input,
            billing,
            signal,
          });
      const approved =
        approval.decision === "accept" ||
        approval.decision === "accept-session";
      if (!approved) {
        const content = JSON.stringify({
          status: "rejected_by_user",
          ...(approval.rejectionReason
            ? { reason: approval.rejectionReason }
            : {}),
          ...(approval.followUp ? { follow_up: approval.followUp } : {}),
        });
        return {
          content,
          stop: false,
          toolMessage: this.buildAskAgentToolResultMessage(
            toolCall,
            content,
            true,
          ),
        };
      }
      if (approval.decision === "accept-session") {
        this.askAgentSessionStore.approveGenerateImageForSession();
        await this.persistAskAgentHistory();
      }
      const result = await generateCodexImages({
        auth: credential,
        prompt: input.prompt,
        count: input.count,
        size: input.size,
        timeoutMs: input.timeoutMs,
        generatedImages,
        sessionId: this.askAgentSessionStore.getActiveSessionId(),
        signal,
      });
      const modelContent: CoreModelContentBlock[] = [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "accepted",
              model: result.model,
              billing,
              requested_count: input.count,
              generated_count: result.images.length,
              saved: false,
              reference_images: [],
              images: codexGeneratedImageMetadata(result.images),
              event_types: Array.from(new Set(result.eventTypes)),
              ...(approval.followUp ? { follow_up: approval.followUp } : {}),
            },
            null,
            2,
          ),
        },
        ...result.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: "image/png" as const,
            data: image.base64,
          },
        })),
      ];
      const resultImages = result.images.map((image) => ({
        mimeType: image.mimeType,
        data: image.base64,
      }));
      const content = (modelContent[0] as { type: "text"; text: string }).text;
      this.logAskAgentEvent("ask-agent.tool.generate_image", {
        ok: true,
        imageCount: resultImages.length,
      });
      return {
        content,
        modelContent,
        resultImages,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          false,
          modelContent,
        ),
      };
    } catch (err) {
      const content = JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        ...codexImageGenerationErrorMetadata(err),
        ...(generatedImages.length > 0
          ? {
              generated_count: generatedImages.length,
              partial_images: codexGeneratedImageMetadata(generatedImages),
            }
          : {}),
      });
      this.logAskAgentEvent("ask-agent.tool.generate_image", {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
  }

  private async executeAskAgentNativeWebTool(
    toolCall: BrowserGatewayAskAgentToolCall,
    policy: Readonly<CoreResolvedWebAccessPolicy>,
    credential: BrowserGatewayModelCredentialRecord,
    model: string,
    signal: AbortSignal,
  ): Promise<AskAgentToolExecutionResult> {
    const kind = toolCall.name === "web_search" ? "search" : "fetch";
    const route = policy.routes[kind];
    if (!route.available || !route.hostedTool) {
      const content = JSON.stringify({
        error: `Native web ${kind} is not available for this request.`,
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }

    const executeNativeWebTool =
      this.askAgentModelClient.executeNativeWebTool?.bind(
        this.askAgentModelClient,
      );
    if (executeNativeWebTool) {
      try {
        const directResult = await executeNativeWebTool({
          credential,
          model,
          kind,
          input: toolCall.input,
          settings: policy.settings,
          signal,
        });
        if (directResult) {
          const content = JSON.stringify(directResult, null, 2);
          this.logAskAgentEvent(`ask-agent.tool.web_${kind}`, {
            ok: true,
            provider: directResult.provider,
            transport: "standalone",
            activities: directResult.activities.length,
            citations: directResult.citations.length,
          });
          return {
            content,
            modelResult: content,
            stop: false,
            toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
          };
        }
      } catch (error) {
        if (signal.aborted) throw error;
        this.logAskAgentEvent(`ask-agent.tool.web_${kind}.standalone`, {
          ok: false,
          fallback: "delegated",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const completeWithToolCalls =
      this.askAgentModelClient.completeWithToolCalls?.bind(
        this.askAgentModelClient,
      );
    if (!completeWithToolCalls) {
      const content = JSON.stringify({
        error: `Native web ${kind} is not available for this request.`,
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }

    try {
      const hostedTool = route.hostedTool;
      const prompt = buildNativeWebDelegationPrompt(kind, toolCall.input);
      const activitiesById = new Map<string, CoreWebActivity>();
      const citations: CoreWebCitation[] = [];
      const citationKeys = new Set<string>();
      const appendCitation = (citation: CoreWebCitation) => {
        const key = JSON.stringify([
          citation.url,
          citation.title ?? "",
          citation.startIndex ?? null,
          citation.endIndex ?? null,
          citation.citedText ?? "",
        ]);
        if (citationKeys.has(key)) return;
        citationKeys.add(key);
        citations.push(structuredClone(citation));
      };
      const iterationMessages: CoreModelMessage[] = [
        { role: "user", content: prompt.userPrompt },
      ];
      const textParts: string[] = [];
      let usage: CoreModelUsage | undefined;
      for (let pauseTurns = 0; ; pauseTurns += 1) {
        const result = await completeWithToolCalls({
          credential,
          model,
          reasoningEffort: "low",
          messages: [],
          instructions: prompt.systemPrompt,
          iterationMessages,
          tools: [],
          hostedTools: [hostedTool],
          maxTokens: 16_384,
          signal,
          onWebActivity: (activity) => {
            activitiesById.set(activity.id, structuredClone(activity));
            for (const citation of activity.citations ?? []) {
              appendCitation(citation);
            }
          },
          onWebCitations: (nextCitations) => {
            for (const citation of nextCitations) appendCitation(citation);
          },
        });
        if (result.text.trim()) textParts.push(result.text.trim());
        usage = mergeNativeWebUsage(usage, result.usage);
        if (result.stopReason !== "pause_turn") break;
        if (!result.assistantMessage) {
          throw new Error(
            `Provider native web ${kind} paused without replay state.`,
          );
        }
        if (pauseTurns >= CORE_NATIVE_WEB_MAX_PAUSE_TURNS) {
          throw new Error(
            `Provider native web continuation exceeded ${CORE_NATIVE_WEB_MAX_PAUSE_TURNS} pause turns.`,
          );
        }
        iterationMessages.push(result.assistantMessage);
      }
      const resultText = textParts.join("\n\n").trim();
      if (!resultText) {
        throw new Error(`Provider native web ${kind} returned no content.`);
      }
      const visibleResult: CoreNativeWebToolResult = {
        backend: "provider",
        provider: normalizeBrowserGatewayModelCredentialProviderId(
          credential.providerId,
        ),
        operation: kind,
        input: structuredClone(toolCall.input),
        activities: [...activitiesById.values()],
        content: resultText,
        citations,
        ...(usage ? { usage } : {}),
      };
      const content = JSON.stringify(visibleResult, null, 2);
      this.logAskAgentEvent(`ask-agent.tool.web_${kind}`, {
        ok: true,
        provider: visibleResult.provider,
        activities: visibleResult.activities.length,
        citations: visibleResult.citations.length,
      });
      return {
        content,
        modelResult: content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const content = JSON.stringify({ error: message });
      this.logAskAgentEvent(`ask-agent.tool.web_${kind}`, {
        ok: false,
        error: message,
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
  }

  private async executeAskAgentSafeProjectlessTool(
    toolCall: BrowserGatewayAskAgentToolCall,
    preparedWebAccess: PreparedAskAgentWebAccess,
    credential: BrowserGatewayModelCredentialRecord | undefined,
    model: string,
    modelOwnerId: string,
    signal: AbortSignal,
  ): Promise<AskAgentToolExecutionResult> {
    const startedAt = Date.now();
    if (toolCall.name === "web_search" || toolCall.name === "web_fetch") {
      if (!credential) {
        throw new Error(
          "browser_gateway_native_web_unavailable:credential_missing",
        );
      }
      return await this.executeAskAgentNativeWebTool(
        toolCall,
        preparedWebAccess.policy,
        credential,
        model,
        signal,
      );
    }
    const mcpBridgeTarget = preparedWebAccess.target;
    if (
      MCP_TOOL_BRIDGE_TOOL_NAMES.includes(toolCall.name) ||
      toolCall.name.includes("__")
    ) {
      return await this.executeAskAgentMcpTool(
        toolCall,
        mcpBridgeTarget,
        signal,
      );
    }

    if (
      !ASK_AGENT_SAFE_PROJECTLESS_TOOL_NAMES.includes(
        toolCall.name as (typeof ASK_AGENT_SAFE_PROJECTLESS_TOOL_NAMES)[number],
      )
    ) {
      const content = `Ask Agent cannot execute \`${toolCall.name}\` because it is projectless/read-only. Only safe session UI tools and explicitly granted read-only local file/list/search tools are available.`;
      this.logAskAgentEvent("ask-agent.tool.denied", {
        toolName: toolCall.name,
        ok: false,
        error: "ask_agent_tool_not_allowed",
      });
      return {
        content,
        stop: true,
        outcome: "model_final",
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }

    if (toolCall.name === "generate_image") {
      return await this.executeAskAgentGenerateImageTool(
        toolCall,
        mcpBridgeTarget,
        modelOwnerId,
        signal,
      );
    }

    if (
      toolCall.name === "manage_memory" ||
      toolCall.name === "recall_memory"
    ) {
      return await this.executeAskAgentAutonomousMemoryTool(toolCall);
    }

    if (toolCall.name === "present_images") {
      return this.executeAskAgentPresentImagesTool(toolCall);
    }

    if (toolCall.name === "todo_write") {
      const { content, todos } = handleTodoWrite(
        toolCall.input as unknown as TodoToolInput,
      );
      this.askAgentController.setTodos(todos);
      this.logAskAgentEvent("ask-agent.tool.todo_write", {
        ok: true,
        todos: todos.length,
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
      };
    }

    if (toolCall.name === "read_file") {
      return await this.executeAskAgentReadFileTool(toolCall);
    }

    if (toolCall.name === "list_files") {
      return await this.executeAskAgentListFilesTool(toolCall);
    }

    if (toolCall.name === "search_files") {
      return await this.executeAskAgentSearchFilesTool(toolCall);
    }

    if (toolCall.name === "ask_user") {
      const questionRequest = this.buildAskAgentQuestionRequest(toolCall);
      if (!questionRequest || "error" in questionRequest) {
        const content = JSON.stringify({
          error:
            questionRequest?.error ??
            "ask_user requires at least one question and visible context in this tool call through top-level context or questions[].context. Preceding assistant messages are intentionally not used because the question card must remain self-contained.",
        });
        return {
          content,
          stop: false,
          toolMessage: this.buildAskAgentToolResultMessage(
            toolCall,
            content,
            true,
          ),
        };
      }
      this.askAgentController.setQuestionRequest(questionRequest);
      const content = JSON.stringify({
        ok: true,
        pendingQuestionId: toolCall.id,
      });
      this.logAskAgentEvent("ask-agent.tool.ask_user", {
        ok: true,
        questionId: toolCall.id,
        questionCount: questionRequest.questions.length,
      });
      return {
        content: "I need your input before continuing.",
        stop: true,
        outcome: "model_question",
        toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
        modelResult: content,
      };
    }

    return this.executeAskAgentFinalStatusTool(toolCall, startedAt);
  }

  private async executeAskAgentAutonomousMemoryTool(
    toolCall: BrowserGatewayAskAgentToolCall,
  ): Promise<AskAgentToolExecutionResult> {
    await this.refreshAskAgentAutonomousMemoryRuntime();
    const context = {
      sessionId: this.askAgentSessionStore.getActiveSessionId(),
      isBackground: false,
      observedAt: new Date().toISOString(),
    };
    const result =
      toolCall.name === "manage_memory"
        ? await handleManageMemory(
            toolCall.input as unknown as ManageMemoryToolInput,
            context,
            this.askAgentAutonomousMemoryRuntime,
          )
        : await handleRecallMemory(
            toolCall.input as unknown as RecallMemoryToolInput,
            context,
            this.askAgentAutonomousMemoryRuntime,
          );
    const media = askAgentMediaFromToolResult(result);
    this.logAskAgentEvent(`ask-agent.tool.${toolCall.name}`, {
      ok: result.isError !== true,
      memoryMode: this.askAgentAutonomousMemoryRuntime.getResolution().mode,
    });
    return {
      content: media.content,
      modelContent: media.modelContent,
      stop: false,
      toolMessage: this.buildAskAgentToolResultMessage(
        toolCall,
        media.content,
        result.isError === true,
        media.modelContent,
      ),
    };
  }

  private async refreshAskAgentAutonomousMemoryRuntime(): Promise<void> {
    const connected = this.coreOwnerRegistry
      .list(Date.now())
      .filter(
        (registration) =>
          registration.status === "connected" &&
          registration.owner.ownerId !== BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      )
      .map((registration) => {
        const ownerId = registration.owner.ownerId;
        const descriptor = this.askAgentMemoryRuntimeByOwner.get(ownerId);
        return descriptor ? { ownerId, ...descriptor } : { ownerId };
      });
    await this.askAgentAutonomousMemoryRuntime.setOwners(connected);
  }

  private async resolveAskAgentGrantedPath(inputPath: unknown): Promise<{
    path: string;
    grantId: string;
    rootPath: string;
  } | null> {
    if (typeof inputPath !== "string" || !inputPath.trim()) return null;
    const requested = path.resolve(inputPath.trim());
    const requestedRealPath = await fs.realpath(requested).catch(() => null);
    if (!requestedRealPath) return null;
    const grants = this.askAgentSessionStore.getReadGrants();
    for (const grant of grants) {
      const root = await fs.realpath(grant.rootPath).catch(() => null);
      if (!root) continue;
      if (grant.kind === "file") {
        if (requestedRealPath === root) {
          return { path: requestedRealPath, grantId: grant.id, rootPath: root };
        }
        continue;
      }
      if (this.isPathInsideRoot(requestedRealPath, root)) {
        return { path: requestedRealPath, grantId: grant.id, rootPath: root };
      }
    }
    return null;
  }

  private isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return (
      !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  private async executeAskAgentReadFileTool(
    toolCall: BrowserGatewayAskAgentToolCall,
  ): Promise<AskAgentToolExecutionResult> {
    const resolved = await this.resolveAskAgentGrantedPath(toolCall.input.path);
    if (!resolved) {
      const content = JSON.stringify({ error: "path_not_granted" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    const stat = await fs.stat(resolved.path).catch(() => null);
    if (!stat?.isFile()) {
      const content = JSON.stringify({ error: "not_a_file" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    const raw = await fs.readFile(resolved.path, "utf-8");
    const structuredRedaction = isStructuredConfigPath(resolved.path)
      ? redactStructuredSecrets(raw)
      : undefined;
    const visibleRaw = structuredRedaction?.content ?? raw;
    const offset = Math.max(
      1,
      Math.floor(Number(toolCall.input.offset ?? 1)) || 1,
    );
    const limit = Math.max(
      1,
      Math.min(200, Math.floor(Number(toolCall.input.limit ?? 120)) || 120),
    );
    const lines = visibleRaw.split("\n");
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const content = JSON.stringify({
      path: resolved.path,
      offset,
      totalLines: lines.length,
      truncated: offset - 1 + limit < lines.length,
      text: selected
        .map((line, index) => `${offset + index} | ${line}`)
        .join("\n")
        .slice(0, 100_000),
      ...(getStructuredSecretRedactionMetadata(structuredRedaction)
        ? {
            redaction:
              getStructuredSecretRedactionMetadata(structuredRedaction),
          }
        : {}),
    });
    this.logAskAgentEvent("ask-agent.tool.read_file", {
      ok: true,
      grantId: resolved.grantId,
      bytes: raw.length,
    });
    return {
      content,
      stop: false,
      toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
    };
  }

  private async executeAskAgentListFilesTool(
    toolCall: BrowserGatewayAskAgentToolCall,
  ): Promise<AskAgentToolExecutionResult> {
    const resolved = await this.resolveAskAgentGrantedPath(toolCall.input.path);
    if (!resolved) {
      const content = JSON.stringify({ error: "path_not_granted" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    const stat = await fs.stat(resolved.path).catch(() => null);
    if (!stat?.isDirectory()) {
      const content = JSON.stringify({ error: "not_a_directory" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    const recursive = toolCall.input.recursive === true;
    const maxDepth = Math.max(
      0,
      Math.min(
        5,
        Math.floor(Number(toolCall.input.depth ?? (recursive ? 2 : 0))) || 0,
      ),
    );
    const entries: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (entries.length >= 200) return;
      const dirRealPath = await fs.realpath(dir).catch(() => null);
      if (
        !dirRealPath ||
        !this.isPathInsideRoot(dirRealPath, resolved.rootPath)
      ) {
        return;
      }
      const children = await fs.readdir(dirRealPath, { withFileTypes: true });
      for (const child of children) {
        if (entries.length >= 200) return;
        const childPath = path.join(dirRealPath, child.name);
        const childRealPath = await fs.realpath(childPath).catch(() => null);
        if (
          !childRealPath ||
          !this.isPathInsideRoot(childRealPath, resolved.rootPath)
        ) {
          continue;
        }
        const childStat = await fs.stat(childRealPath).catch(() => null);
        if (!childStat) continue;
        const rel = path.relative(resolved.path, childRealPath) || child.name;
        entries.push(childStat.isDirectory() ? `${rel}/` : rel);
        if (recursive && childStat.isDirectory() && depth < maxDepth) {
          await visit(childRealPath, depth + 1);
        }
      }
    };
    await visit(resolved.path, 0);
    const content = JSON.stringify({
      path: resolved.path,
      entries,
      truncated: entries.length >= 200,
    });
    this.logAskAgentEvent("ask-agent.tool.list_files", {
      ok: true,
      grantId: resolved.grantId,
      entries: entries.length,
    });
    return {
      content,
      stop: false,
      toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
    };
  }

  private async executeAskAgentSearchFilesTool(
    toolCall: BrowserGatewayAskAgentToolCall,
  ): Promise<AskAgentToolExecutionResult> {
    const resolved = await this.resolveAskAgentGrantedPath(toolCall.input.path);
    const pattern =
      typeof toolCall.input.regex === "string" ? toolCall.input.regex : "";
    if (!resolved || !pattern) {
      const content = JSON.stringify({
        error: resolved ? "missing_regex" : "path_not_granted",
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      const content = JSON.stringify({ error: "invalid_regex" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    const stat = await fs.stat(resolved.path).catch(() => null);
    if (!stat) {
      const content = JSON.stringify({ error: "path_not_found" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }
    const maxResults = Math.max(
      1,
      Math.min(100, Math.floor(Number(toolCall.input.max_results ?? 50)) || 50),
    );
    const filePattern =
      typeof toolCall.input.file_pattern === "string"
        ? toolCall.input.file_pattern.trim()
        : "";
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const shouldInclude = (filePath: string) =>
      !filePattern || filePath.endsWith(filePattern.replace(/^\*+/, ""));
    const searchFile = async (filePath: string): Promise<void> => {
      if (matches.length >= maxResults || !shouldInclude(filePath)) return;
      const text = await fs.readFile(filePath, "utf-8").catch(() => "");
      if (!text) return;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i] ?? "")) {
          matches.push({
            path: filePath,
            line: i + 1,
            text: (lines[i] ?? "").slice(0, 500),
          });
        }
      }
    };
    const visit = async (targetPath: string, depth: number): Promise<void> => {
      if (matches.length >= maxResults || depth > 5) return;
      const targetRealPath = await fs.realpath(targetPath).catch(() => null);
      if (
        !targetRealPath ||
        !this.isPathInsideRoot(targetRealPath, resolved.rootPath)
      ) {
        return;
      }
      const targetStat = await fs.stat(targetRealPath).catch(() => null);
      if (!targetStat) return;
      if (targetStat.isFile()) {
        await searchFile(targetRealPath);
        return;
      }
      if (!targetStat.isDirectory()) return;
      const children = await fs.readdir(targetRealPath, {
        withFileTypes: true,
      });
      for (const child of children) {
        if (matches.length >= maxResults) return;
        await visit(path.join(targetRealPath, child.name), depth + 1);
      }
    };
    await visit(resolved.path, 0);
    const content = JSON.stringify({
      path: resolved.path,
      matches,
      truncated: matches.length >= maxResults,
    });
    this.logAskAgentEvent("ask-agent.tool.search_files", {
      ok: true,
      grantId: resolved.grantId,
      matches: matches.length,
    });
    return {
      content,
      stop: false,
      toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
    };
  }

  private executeAskAgentFinalStatusTool(
    toolCall: BrowserGatewayAskAgentToolCall,
    startedAt: number,
  ): AskAgentToolExecutionResult {
    const status = toolCall.input.status;
    if (
      status !== "completed" &&
      status !== "waiting_for_user" &&
      status !== "blocked" &&
      status !== "cancelled"
    ) {
      const content = JSON.stringify({ error: "Invalid status" });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          true,
        ),
      };
    }

    const summary =
      typeof toolCall.input.summary === "string"
        ? toolCall.input.summary.trim()
        : "";
    const continueLabel =
      typeof toolCall.input.continueLabel === "string"
        ? toolCall.input.continueLabel.trim()
        : "";
    const continuePrompt =
      typeof toolCall.input.continuePrompt === "string"
        ? toolCall.input.continuePrompt.trim()
        : "";
    const completeTodosRequested = toolCall.input.completeTodos === true;
    const completedTodos =
      status === "completed" && completeTodosRequested
        ? this.askAgentController.completeTodos()
        : undefined;
    const content = JSON.stringify({
      ok: true,
      ...(completedTodos ? { completedTodos: completedTodos.length } : {}),
      ...(completeTodosRequested && status !== "completed"
        ? {
            completeTodosIgnored:
              "completeTodos only applies when status is 'completed'",
          }
        : {}),
    });
    this.recordAskAgentSemanticDelta();
    this.askAgentController.setQuestionRequest(null);
    const marker: FinalMessageMarker = {
      status: status as FinalMessageStatus,
      source: "tool",
      ...(summary ? { summary } : {}),
      ...(continueLabel && continuePrompt
        ? { continueAction: { label: continueLabel, prompt: continuePrompt } }
        : {}),
      toolCall: {
        id: toolCall.id,
        name: "set_task_status",
        inputJson: JSON.stringify(toolCall.input),
        result: content,
        durationMs: Date.now() - startedAt,
      },
    };
    this.askAgentController.applyFinalMarker(marker);
    this.logAskAgentEvent("ask-agent.tool.set_task_status", {
      ok: true,
      status,
      completeTodos: completeTodosRequested,
    });
    return {
      content: summary || "Task status set.",
      stop: true,
      outcome: "model_final",
      toolMessage: this.buildAskAgentToolResultMessage(toolCall, content),
    };
  }

  private buildAskAgentQuestionRequest(
    toolCall: BrowserGatewayAskAgentToolCall,
  ):
    | { id: string; context: string; questions: Question[] }
    | { error: string }
    | null {
    const rawQuestions = Array.isArray(toolCall.input.questions)
      ? toolCall.input.questions
      : [];
    for (const [index, raw] of rawQuestions.entries()) {
      if (!raw || typeof raw !== "object") continue;
      const candidate = raw as Record<string, unknown>;
      if (
        candidate.type !== "confirmation" ||
        candidate.options === undefined
      ) {
        continue;
      }
      const options = candidate.options;
      if (!isConfirmationOptions(options)) {
        const id =
          typeof candidate.id === "string" && candidate.id.trim()
            ? candidate.id.trim()
            : `question-${index + 1}`;
        return {
          error: `Confirmation question "${id}" must have exactly two distinct non-empty options when custom button labels are provided`,
        };
      }
    }
    const questions: Question[] = rawQuestions.flatMap((raw, index) => {
      if (!raw || typeof raw !== "object") return [];
      const candidate = raw as Record<string, unknown>;
      const type = candidate.type;
      if (
        type !== "multiple_choice" &&
        type !== "multiple_select" &&
        type !== "yes_no" &&
        type !== "text" &&
        type !== "scale" &&
        type !== "confirmation"
      ) {
        return [];
      }
      const questionText =
        typeof candidate.question === "string" ? candidate.question.trim() : "";
      if (!questionText) return [];
      const options =
        type === "confirmation" && candidate.options !== undefined
          ? getConfirmationOptions(candidate.options)
          : Array.isArray(candidate.options)
            ? candidate.options.map(String)
            : undefined;

      return [
        {
          id:
            typeof candidate.id === "string" && candidate.id.trim()
              ? candidate.id.trim()
              : `question-${index + 1}`,
          type,
          question: questionText,
          ...(typeof candidate.context === "string" && candidate.context.trim()
            ? { context: candidate.context.trim() }
            : {}),
          ...(options ? { options } : {}),
          ...(typeof candidate.recommended === "string"
            ? { recommended: candidate.recommended }
            : {}),
          ...(typeof candidate.allowBlank === "boolean"
            ? { allowBlank: candidate.allowBlank }
            : {}),
          ...(typeof candidate.scale_min === "number"
            ? { scale_min: candidate.scale_min }
            : {}),
          ...(typeof candidate.scale_max === "number"
            ? { scale_max: candidate.scale_max }
            : {}),
          ...(typeof candidate.scale_min_label === "string"
            ? { scale_min_label: candidate.scale_min_label }
            : {}),
          ...(typeof candidate.scale_max_label === "string"
            ? { scale_max_label: candidate.scale_max_label }
            : {}),
        },
      ];
    });
    const context =
      typeof toolCall.input.context === "string"
        ? toolCall.input.context.trim()
        : "";
    const hasVisibleContext =
      Boolean(context) ||
      questions.some((question) => Boolean(question.context));
    if (questions.length === 0 || !hasVisibleContext) {
      return null;
    }
    return { id: toolCall.id, context, questions };
  }

  private buildAskAgentToolResultMessage(
    toolCall: BrowserGatewayAskAgentToolCall,
    content: string,
    isError = false,
    modelContent: string | CoreModelContentBlock[] = content,
  ): CoreModelMessage {
    return {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        },
        {
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: modelContent,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    };
  }

  private async handleAskAgentRetryRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let activeTurn: AskAgentControllerTurn | null = null;
    try {
      const body = (await readJsonBody(req).catch((err) => {
        if (err instanceof Error && err.message === "invalid_json") throw err;
        return null;
      })) as { sessionId?: unknown; instanceId?: unknown } | null;
      const requestedSessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      if (!requestedSessionId) {
        this.logAskAgentEvent("ask-agent.retry", {
          ok: false,
          error: "invalid_request",
        });
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const now = Date.now();
      const theme = await this.resolveInitialTheme(null);
      if (!this.askAgentSessionStore.hasSession(requestedSessionId)) {
        this.logAskAgentEvent("ask-agent.retry", {
          sessionId: requestedSessionId,
          ok: false,
          error: "ask_agent_session_not_found",
        });
        writeJson(res, 404, { error: "ask_agent_session_not_found" });
        return;
      }
      const requestedOwnerId =
        typeof body?.instanceId === "string" ? body.instanceId.trim() : "";
      const modelContext = this.getAskAgentModelExecutionContext(
        now,
        requestedOwnerId || undefined,
      );
      if (!modelContext) {
        this.logAskAgentEvent("ask-agent.retry", {
          sessionId: requestedSessionId,
          ok: false,
          error: "credential_missing",
        });
        writeJson(res, 409, { error: "credential_missing" });
        return;
      }
      if (this.askAgentController.hasActiveTurn()) {
        this.logAskAgentEvent("ask-agent.retry", {
          sessionId: requestedSessionId,
          ok: false,
          error: "ask_agent_turn_in_progress",
        });
        writeJson(res, 409, { error: "ask_agent_turn_in_progress" });
        return;
      }

      const retryableTurn =
        this.askAgentSessionStore.prepareLatestRetryableTurn({
          sessionId: requestedSessionId,
          now,
        });
      if (!retryableTurn) {
        this.logAskAgentEvent("ask-agent.retry", {
          sessionId: requestedSessionId,
          ok: false,
          error: "ask_agent_retry_unavailable",
        });
        writeJson(res, 409, { error: "ask_agent_retry_unavailable" });
        return;
      }
      await this.pinAskAgentModelOwner(modelContext);

      const { userMessage } = retryableTurn;
      const retryToolResults = retryableTurn.toolResults.map((toolResult) => {
        const mediaBlocks: CoreModelContentBlock[] = [];
        for (const image of toolResult.resultImages ?? []) {
          const mediaType = toCoreModelImageMediaType(image.mimeType);
          if (!mediaType) continue;
          mediaBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: image.data,
            },
          });
        }
        for (const document of toolResult.resultDocuments ?? []) {
          const mediaType = toCoreModelDocumentMediaType(document.mimeType);
          if (!mediaType) continue;
          mediaBlocks.push({
            type: "document",
            title: document.name,
            source: {
              type: "base64",
              media_type: mediaType,
              data: document.data,
            },
          });
        }
        const modelContent: CoreModelContentBlock[] | undefined =
          mediaBlocks.length
            ? [{ type: "text", text: toolResult.result }, ...mediaBlocks]
            : undefined;
        return this.buildAskAgentToolResultMessage(
          {
            id: toolResult.toolCallId,
            name: toolResult.toolName,
            input: toolResult.input,
          },
          toolResult.result,
          false,
          modelContent ?? toolResult.result,
        );
      });
      const sendLogFields = {
        sessionId: this.askAgentSessionStore.getActiveSessionId(),
        textChars: userMessage.content.trim().length,
        credential: "ready",
        model: this.askAgentSessionStore.getModel(),
        reasoning: this.askAgentSessionStore.getReasoningEffort(),
        retryToolMessages: retryToolResults.length,
      };
      logHelper(
        `ask-agent retry sessionId=${sendLogFields.sessionId} textChars=${sendLogFields.textChars} credential=ready model=${sendLogFields.model} reasoning=${sendLogFields.reasoning}`,
      );
      this.logAskAgentEvent("ask-agent.retry", {
        ...sendLogFields,
        ok: true,
        phase: "received",
      });

      const assistantMessage = this.askAgentSessionStore.startAssistantMessage({
        now,
      });
      activeTurn = this.askAgentController.beginTurn(assistantMessage.id);
      if (!activeTurn) throw new Error("ask_agent_turn_in_progress");
      const streamSnapshot = this.askAgentController.projectState({
        now,
        theme,
        modelCredentialStatus: this.getAskAgentModelCredentialStatus(
          now,
          modelContext.ownerId,
        ),
        approval: this.askAgentController.getPendingApproval(),
        memoryCandidateNudge: this.askAgentController.getMemoryCandidateNudge(),
      });
      await this.publishAskAgentSnapshot(streamSnapshot.snapshot);

      let sendOutcome = "model_success";
      try {
        const transcriptMessages = this.askAgentSessionStore
          .getTranscriptMessages()
          .filter((message) => message.id !== assistantMessage.id);
        const memoryContextResult = await this.buildAskAgentMemoryContext({
          query: userMessage.content,
          activeSessionId: this.askAgentSessionStore.getActiveSessionId(),
          transcriptMessages,
        });
        const turnResult = await this.runAskAgentModelTurn({
          modelContext,
          assistantMessageId: assistantMessage.id,
          transcriptMessages,
          memoryContext: memoryContextResult?.context,
          memoryDisclosure: memoryContextResult?.disclosure,
          initialToolMessages: retryToolResults,
          theme,
          signal: activeTurn.signal,
        });
        sendOutcome = turnResult.outcome;
      } catch (err) {
        const authFailed =
          err instanceof Error &&
          err.message === "browser_gateway_ask_agent_model_auth_failed";
        const stopped =
          err instanceof Error &&
          err.message === "browser_gateway_ask_agent_model_aborted";
        const alreadyStopped =
          stopped && this.askAgentController.isTurnStopped(activeTurn);
        const errorPresentation = buildAskAgentModelErrorPresentation({
          error: err,
          authFailed,
          stopped,
        });
        if (authFailed) {
          this.clearAskAgentModelCredential();
        }
        sendOutcome = stopped
          ? "model_stopped"
          : authFailed
            ? "model_auth_failed"
            : "model_error";
        this.logAskAgentEvent("ask-agent.retry.model_error", {
          ...sendLogFields,
          ...getSanitizedModelErrorFields(err),
          ok: false,
          error: sendOutcome,
        });
        if (!alreadyStopped) {
          this.askAgentController.finishAssistantError({
            messageId: assistantMessage.id,
            text: errorPresentation.message,
            code: errorPresentation.code ?? sendOutcome,
            retryable: errorPresentation.retryable,
            actions: errorPresentation.actions,
          });
        }
      }

      await this.persistAskAgentHistory();
      this.askAgentController.recordTurnOutcome(
        this.askAgentSessionStore.getActiveSessionId(),
        sendOutcome,
      );
      const response = this.buildAskAgentSnapshotResponse(Date.now(), theme);
      this.logAskAgentEvent("ask-agent.retry.complete", {
        ...sendLogFields,
        ok: true,
        outcome: sendOutcome,
        messageCount:
          response.snapshot.session.foreground.projectedMessages.length,
      });
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.retry", {
        ok: false,
        error: invalidJson ? "invalid_json" : "internal_error",
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    } finally {
      if (activeTurn) this.askAgentController.completeTurn(activeTurn);
    }
  }

  private async handleAskAgentSendRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let activeTurn: AskAgentControllerTurn | null = null;
    try {
      const body = (await readJsonBody(req)) as {
        id?: unknown;
        text?: unknown;
        sessionId?: unknown;
        attachments?: unknown;
        images?: unknown;
        documents?: unknown;
        instanceId?: unknown;
      } | null;
      const images = parseAskAgentMediaItems(body?.images);
      const documents = parseAskAgentMediaItems(body?.documents);
      const hasMedia = images.length > 0 || documents.length > 0;
      if (
        !body ||
        typeof body.text !== "string" ||
        (!body.text.trim() && !hasMedia)
      ) {
        this.logAskAgentEvent("ask-agent.send", {
          ok: false,
          error: "invalid_request",
        });
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const requestedSessionId =
        typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (
        requestedSessionId &&
        !this.askAgentSessionStore.hasSession(requestedSessionId)
      ) {
        this.logAskAgentEvent("ask-agent.send", {
          sessionId: requestedSessionId,
          ok: false,
          error: "ask_agent_session_not_found",
        });
        writeJson(res, 404, { error: "ask_agent_session_not_found" });
        return;
      }
      if (
        requestedSessionId &&
        requestedSessionId !== this.askAgentSessionStore.getActiveSessionId()
      ) {
        const activeSessionId = this.askAgentSessionStore.getActiveSessionId();
        this.logAskAgentEvent("ask-agent.send", {
          sessionId: requestedSessionId,
          activeSessionId,
          ok: false,
          error: "ask_agent_session_mismatch",
        });
        writeJson(res, 409, {
          error: "ask_agent_session_mismatch",
          activeSessionId,
        });
        return;
      }
      if (Array.isArray(body.attachments) && body.attachments.length > 0) {
        this.logAskAgentEvent("ask-agent.send", {
          sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
          textChars: body.text.trim().length,
          ok: false,
          error: "ask_agent_path_attachments_unavailable",
        });
        writeJson(res, 400, {
          error: "ask_agent_path_attachments_unavailable",
        });
        return;
      }

      const now = Date.now();
      const theme = await this.resolveInitialTheme(null);
      if (
        requestedSessionId &&
        requestedSessionId !== this.askAgentSessionStore.getActiveSessionId()
      ) {
        const activeSessionId = this.askAgentSessionStore.getActiveSessionId();
        this.logAskAgentEvent("ask-agent.send", {
          sessionId: requestedSessionId,
          activeSessionId,
          ok: false,
          error: "ask_agent_session_mismatch",
        });
        writeJson(res, 409, {
          error: "ask_agent_session_mismatch",
          activeSessionId,
        });
        return;
      }
      const activeSessionId = this.askAgentSessionStore.getActiveSessionId();
      const priorUserTexts =
        this.askAgentSessionStore.getActiveUserMessageTexts();
      const requestedOwnerId =
        typeof body.instanceId === "string" ? body.instanceId.trim() : "";
      const modelContext = this.getAskAgentModelExecutionContext(
        now,
        requestedOwnerId || undefined,
      );
      if (requestedOwnerId && !modelContext) {
        this.logAskAgentEvent("ask-agent.send", {
          instanceId: requestedOwnerId,
          ok: false,
          error: "credential_missing",
        });
        writeJson(res, 409, { error: "credential_missing" });
        return;
      }
      let response: AskAgentSessionResponse | null = null;
      const sendLogFields = {
        sessionId: typeof body.sessionId === "string" ? body.sessionId : "none",
        textChars: body.text.trim().length,
        imageCount: images.length,
        documentCount: documents.length,
        credential: modelContext
          ? modelContext.credential
            ? "ready"
            : "no-auth"
          : "missing",
        model: this.askAgentSessionStore.getModel(),
        reasoning: this.askAgentSessionStore.getReasoningEffort(),
      };
      logHelper(
        `ask-agent send sessionId=${sendLogFields.sessionId} textChars=${sendLogFields.textChars} credential=${sendLogFields.credential} model=${sendLogFields.model} reasoning=${sendLogFields.reasoning}`,
      );
      this.logAskAgentEvent("ask-agent.send", {
        ...sendLogFields,
        ok: true,
        phase: "received",
      });
      const duplicateUserMessage =
        typeof body.id === "string" &&
        this.askAgentSessionStore.hasActiveUserMessageId(body.id);
      let sendOutcome = modelContext ? "model_success" : "credential_missing";
      if (duplicateUserMessage) {
        response = this.buildAskAgentSnapshotResponse(now, theme);
        sendOutcome = "duplicate_ignored";
      } else if (modelContext && this.askAgentController.hasActiveTurn()) {
        this.logAskAgentEvent("ask-agent.send", {
          ...sendLogFields,
          ok: false,
          error: "ask_agent_turn_in_progress",
        });
        writeJson(res, 409, { error: "ask_agent_turn_in_progress" });
        return;
      }
      if (!duplicateUserMessage && modelContext) {
        await this.pinAskAgentModelOwner(modelContext);
        if (
          requestedSessionId &&
          requestedSessionId !== this.askAgentSessionStore.getActiveSessionId()
        ) {
          const currentSessionId =
            this.askAgentSessionStore.getActiveSessionId();
          this.logAskAgentEvent("ask-agent.send", {
            sessionId: requestedSessionId,
            activeSessionId: currentSessionId,
            ok: false,
            error: "ask_agent_session_mismatch",
          });
          writeJson(res, 409, {
            error: "ask_agent_session_mismatch",
            activeSessionId: currentSessionId,
          });
          return;
        }
        this.askAgentSessionStore.appendUserMessage({
          id: typeof body.id === "string" ? body.id : undefined,
          text: body.text,
          now,
          displayMedia: askAgentMediaToDisplayMedia({ images, documents }),
          media: { images, documents },
        });
        const assistantMessage =
          this.askAgentSessionStore.startAssistantMessage({
            now,
          });
        activeTurn = this.askAgentController.beginTurn(assistantMessage.id);
        if (!activeTurn) throw new Error("ask_agent_turn_in_progress");
        const streamSnapshot = this.askAgentController.projectState({
          now,
          theme,
          modelCredentialStatus: this.getAskAgentModelCredentialStatus(
            now,
            modelContext.ownerId,
          ),
          approval: this.askAgentController.getPendingApproval(),
          memoryCandidateNudge:
            this.askAgentController.getMemoryCandidateNudge(),
        });
        await this.publishAskAgentSnapshot(streamSnapshot.snapshot);
        try {
          const transcriptMessages = this.askAgentSessionStore
            .getTranscriptMessages()
            .filter((message) => message.id !== assistantMessage.id);
          const memoryContextResult = await this.buildAskAgentMemoryContext({
            query: body.text,
            activeSessionId: this.askAgentSessionStore.getActiveSessionId(),
            transcriptMessages,
          });
          const turnResult = await this.runAskAgentModelTurn({
            modelContext,
            assistantMessageId: assistantMessage.id,
            transcriptMessages,
            memoryContext: memoryContextResult?.context,
            memoryDisclosure: memoryContextResult?.disclosure,
            theme,
            signal: activeTurn.signal,
          });
          sendOutcome = turnResult.outcome;
        } catch (err) {
          const authFailed =
            err instanceof Error &&
            err.message === "browser_gateway_ask_agent_model_auth_failed";
          const stopped =
            err instanceof Error &&
            err.message === "browser_gateway_ask_agent_model_aborted";
          const alreadyStopped =
            stopped && this.askAgentController.isTurnStopped(activeTurn);
          const errorPresentation = buildAskAgentModelErrorPresentation({
            error: err,
            authFailed,
            stopped,
          });
          if (authFailed) {
            this.clearAskAgentModelCredential();
          }
          sendOutcome = stopped
            ? "model_stopped"
            : authFailed
              ? "model_auth_failed"
              : "model_error";
          this.logAskAgentEvent("ask-agent.send.model_error", {
            ...sendLogFields,
            ...getSanitizedModelErrorFields(err),
            ok: false,
            error: sendOutcome,
          });
          if (!alreadyStopped) {
            this.askAgentController.finishAssistantError({
              messageId: assistantMessage.id,
              text: errorPresentation.message,
              code: errorPresentation.code ?? sendOutcome,
              retryable: errorPresentation.retryable,
              actions: errorPresentation.actions,
            });
          }
        }
        await this.persistAskAgentHistory();
        this.askAgentController.recordTurnOutcome(activeSessionId, sendOutcome);
        this.maybeCreateAskAgentMemoryCandidateNudge({
          text: body.text,
          priorUserTexts,
          sessionId: activeSessionId,
          now: Date.now(),
        });
        response = this.buildAskAgentSnapshotResponse(Date.now(), theme);
      } else if (!duplicateUserMessage) {
        response = this.askAgentSessionStore.sendMessage({
          id: typeof body.id === "string" ? body.id : undefined,
          text: body.text,
          now,
          theme,
          modelCredentialStatus: this.getAskAgentModelCredentialStatus(now),
          media: { images, documents },
        });
        this.maybeCreateAskAgentMemoryCandidateNudge({
          text: body.text,
          priorUserTexts,
          sessionId: activeSessionId,
          now: Date.now(),
        });
        response = this.buildAskAgentSnapshotResponse(Date.now(), theme);
        await this.persistAskAgentHistory();
      }
      response ??= this.buildAskAgentSnapshotResponse(Date.now(), theme);
      this.logAskAgentEvent("ask-agent.send.complete", {
        ...sendLogFields,
        ok: true,
        outcome: sendOutcome,
        messageCount:
          response.snapshot.session.foreground.projectedMessages.length,
      });
      // Return the snapshot for the sender's immediate UI update and broadcast
      // the same full snapshot for any other connected Ask Agent browser tabs.
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, { ok: true, snapshot: response.snapshot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "browser_gateway_ask_agent_empty_message") {
        this.logAskAgentEvent("ask-agent.send", {
          ok: false,
          error: "invalid_request",
        });
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      this.logAskAgentEvent("ask-agent.send", {
        ok: false,
        error: invalidJson ? "invalid_json" : "internal_error",
      });
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    } finally {
      if (activeTurn) this.askAgentController.completeTurn(activeTurn);
    }
  }

  private async handleAskAgentStopRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    const publication = await this.cancelActiveTurn();
    if (!publication) {
      writeJson(res, 200, { ok: true, stopped: false });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      stopped: true,
      snapshot: publication.snapshot,
    });
  }

  cancelActiveTurn(): Promise<AskAgentControllerPublication | null> {
    return this.askAgentController.cancelActiveTurn((messageId) =>
      this.commitAskAgentCancellation(messageId),
    );
  }

  private async commitAskAgentCancellation(
    messageId: string,
  ): Promise<AskAgentControllerPublication> {
    this.logAskAgentEvent("ask-agent.stop", {
      messageId,
      ok: true,
    });
    const errorPresentation = buildAskAgentModelErrorPresentation({
      error: new Error("browser_gateway_ask_agent_model_aborted"),
      authFailed: false,
      stopped: true,
    });
    this.askAgentController.finishAssistantError({
      messageId,
      text: errorPresentation.message,
      code: errorPresentation.code ?? "model_stopped",
      retryable: errorPresentation.retryable,
      actions: errorPresentation.actions,
    });
    const now = Date.now();
    await this.persistAskAgentHistory();
    const response = this.buildAskAgentSnapshotResponse(
      now,
      await this.resolveInitialTheme(null),
    );
    return await this.askAgentController.publishSnapshot(response.snapshot);
  }

  private serializeAskAgentSnapshot(
    snapshot: AskAgentControllerSnapshot,
  ): string {
    const startedAt = this.streamingMetrics.enabled ? performance.now() : 0;
    const serialized = JSON.stringify(snapshot);
    if (this.streamingMetrics.enabled) {
      this.streamingMetrics.record({
        type: "serialization",
        surface: "ask-agent-helper",
        durationMs: performance.now() - startedAt,
        bytes: utf8ByteLength(serialized),
      });
    }
    return serialized;
  }

  private publishAskAgentSnapshot(
    snapshot: AskAgentControllerSnapshot,
  ): Promise<AskAgentControllerPublication> {
    return this.askAgentController.publishSnapshot(snapshot);
  }

  async dispose(): Promise<void> {
    await this.askAgentController.dispose();
    await this.askAgentOwnerAdapter.dispose();
    await this.askAgentDerivedSessionRuntime.dispose();
    await this.askAgentAutonomousMemoryRuntime.dispose();
  }

  private broadcastAskAgentPublication(
    publication: AskAgentControllerPublication,
  ): void {
    const result = this.askAgentSseHub.broadcast(
      this.toAskAgentSsePublication(publication),
    );
    if (this.streamingMetrics.enabled) {
      this.streamingMetrics.record({
        type: "broadcast",
        surface: "ask-agent-helper",
        clientCount: result.attempted,
        deliveredClientCount: result.delivered,
        bytes: publication.bytes,
      });
    }
  }

  private toAskAgentSsePublication(
    publication: AskAgentControllerPublication,
  ): SsePublication<AskAgentControllerSnapshot> {
    return {
      revision: publication.revision,
      value: publication.snapshot,
      serialized: publication.serialized,
      bytes: publication.bytes,
    };
  }

  private recordAskAgentSnapshotBuild(
    snapshot: AskAgentControllerSnapshot,
    durationMs: number,
  ): void {
    if (!this.streamingMetrics.enabled) return;
    const messageCount = snapshot.session.foreground.projectedMessages.length;
    this.streamingMetrics.record({
      type: "snapshot_build",
      surface: "ask-agent-helper",
      durationMs,
      messageCount,
    });
    this.streamingMetrics.record({
      type: "message_projection",
      surface: "ask-agent-helper",
      durationMs,
      messageCount,
    });
  }

  private recordAskAgentSemanticDelta(): void {
    if (!this.streamingMetrics.enabled) return;
    this.streamingMetrics.record({
      type: "delta",
      surface: "ask-agent-helper",
      kind: "semantic",
      chars: 0,
    });
  }

  private recordAskAgentClientCount(clientCount: number): void {
    if (!this.streamingMetrics.enabled) return;
    this.streamingMetrics.record({
      type: "sse_clients",
      surface: "ask-agent-helper",
      clientCount,
    });
  }

  private recordAskAgentClientRemoval(reason: SseClientRemovalReason): void {
    if (!this.streamingMetrics.enabled) return;
    this.streamingMetrics.record({
      type: "sse_client_removed",
      surface: "ask-agent-helper",
      reason,
    });
  }

  private recordAskAgentFirstDelivery(sample: {
    durationMs: number;
    bytes: number;
  }): void {
    if (!this.streamingMetrics.enabled) return;
    this.streamingMetrics.record({
      type: "sse_first_delivery",
      surface: "ask-agent-helper",
      ...sample,
    });
  }

  private async handleProxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const instances = requestedInstanceId
      ? await listBrowserGatewayInstances()
      : await listHealthyBrowserGatewayInstances();
    const instance = requestedInstanceId
      ? (instances.find(
          (candidate) =>
            candidate.instanceId === requestedInstanceId &&
            isBrowserGatewayInstanceProcessAlive(candidate),
        ) ?? null)
      : this.selectInstance(instances);

    if (!instance) {
      this.writeInstancesJson(
        res,
        "",
        instances,
        requestedInstanceId ? 404 : 503,
        requestedInstanceId ? "instance_not_found" : "no_instances_available",
      );
      return;
    }

    await this.proxyToInstance(req, res, requestUrl, instance);
  }

  private async resolveInitialTheme(
    selectedInstance: BrowserGatewayInstanceRecord | null,
  ): Promise<BrowserGatewayThemeSnapshot> {
    if (selectedInstance?.theme) return selectedInstance.theme;
    return (
      (await readBrowserGatewayThemeCache()) ?? BAKED_BROWSER_GATEWAY_THEME
    );
  }

  private selectInstance(
    instances: BrowserGatewayInstanceRecord[],
    requestedInstanceId?: string,
  ): BrowserGatewayInstanceRecord | null {
    if (instances.length === 0) return null;
    if (requestedInstanceId) {
      const exact = instances.find((i) => i.instanceId === requestedInstanceId);
      if (exact) return exact;
    }
    return instances[0] ?? null;
  }

  private async buildInstanceListItems(
    instances: BrowserGatewayInstanceRecord[],
  ): Promise<BrowserGatewayInstanceListItem[]> {
    const statuses = await Promise.all(
      instances.map((instance) => this.fetchInstanceStatus(instance)),
    );

    return instances.map(({ authToken: _authToken, ...instance }, index) => ({
      ...instance,
      status: statuses[index],
    }));
  }

  private async fetchInstanceStatus(
    instance: BrowserGatewayInstanceRecord,
  ): Promise<BrowserGatewayInstanceStatusSummary | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(`${instance.url}/api/instance-status`, {
        headers: { authorization: `Bearer ${instance.authToken}` },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return (await response.json()) as BrowserGatewayInstanceStatusSummary;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private writeInstancesJson(
    res: http.ServerResponse,
    currentInstanceId: string,
    instances: BrowserGatewayInstanceListItem[],
    status = 200,
    error?: string,
    dataPlaneMode = this.resolveEffectiveDataPlaneModeFromInstances(instances),
  ): void {
    const body = error
      ? { currentInstanceId, instances, error }
      : { currentInstanceId, instances, dataPlaneMode, error };
    writeJson(res, status, body);
  }

  private async proxyToInstance(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
    instance: BrowserGatewayInstanceRecord,
  ): Promise<void> {
    const isEventStream = requestUrl.pathname === "/events";
    if (isEventStream) {
      req.socket.setTimeout(0);
      res.socket?.setTimeout(0);
    }
    const targetBase = new URL(instance.url);
    const forwardedUrl = new URL(requestUrl.pathname, targetBase);

    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === "instanceId") continue;
      forwardedUrl.searchParams.append(key, value);
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    if (instance.authToken && instance.authToken.trim()) {
      headers.authorization = `Bearer ${instance.authToken}`;
    } else {
      delete headers.authorization;
    }

    await new Promise<void>((resolve) => {
      let proxyResponse: http.IncomingMessage | undefined;
      const proxyReq = http.request(
        {
          protocol: targetBase.protocol,
          hostname: targetBase.hostname,
          port: targetBase.port,
          method: req.method,
          path: `${forwardedUrl.pathname}${forwardedUrl.search}`,
          headers,
          timeout: isEventStream ? 0 : undefined,
        },
        (proxyRes) => {
          proxyResponse = proxyRes;
          if (isEventStream) {
            proxyRes.socket.setTimeout(0);
          }
          const statusCode = proxyRes.statusCode ?? 502;
          const responseHeaders = { ...proxyRes.headers };
          res.writeHead(statusCode, responseHeaders);
          proxyRes.pipe(res);
          proxyRes.on("end", () => resolve());
          proxyRes.on("close", () => resolve());
        },
      );
      if (isEventStream) {
        this.lifecycle.trackStream(res, () => {
          proxyReq.destroy();
          proxyResponse?.destroy();
          if (!res.destroyed && !res.writableEnded) res.end();
        });
      }

      proxyReq.on("error", (error) => {
        invalidateBrowserGatewayInstanceHealth(instance.instanceId);
        if (!res.headersSent) {
          writeJson(res, 502, {
            error: "proxy_error",
            detail: String(error),
          });
        }
        resolve();
      });

      req.on("aborted", () => {
        proxyReq.destroy();
      });
      res.on("close", () => {
        proxyReq.destroy();
        resolve();
      });

      if (req.method === "GET" || req.method === "HEAD") {
        proxyReq.end();
      } else {
        req.pipe(proxyReq);
      }
    });
  }

  private isAllowedRelayHost(host: string): boolean {
    if (!/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/.test(host)) {
      return false;
    }
    let requestedOrigin: string;
    try {
      requestedOrigin = new URL(`http://${host}`).origin;
    } catch {
      return false;
    }
    const allowedOrigins = new Set([
      `http://localhost:${this.options.port}`,
      `http://127.0.0.1:${this.options.port}`,
      `http://[::1]:${this.options.port}`,
      ...listLanIpv4UrlsForPort(this.options.port).map(
        (url) => new URL(url).origin,
      ),
      ...(this.mdnsState.url ? [new URL(this.mdnsState.url).origin] : []),
    ]);
    return allowedOrigins.has(requestedOrigin);
  }

  private isInternalClientAuthorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return auth === `Bearer ${this.clientSharedSecret}`;
  }

  private buildBootstrapCookie(): string {
    return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(this.browserBootstrapToken)}; Path=/; HttpOnly; SameSite=Lax`;
  }

  private buildDeviceCookie(token: string): string {
    // Persist across restarts — a year. Pairing is revocable server-side.
    const maxAge = 60 * 60 * 24 * 365;
    return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  private readCookie(req: http.IncomingMessage, name: string): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const [rawName, ...rawValueParts] = trimmed.split("=");
      if (rawName !== name) continue;
      const rawValue = rawValueParts.join("=");
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
    return null;
  }

  private async authenticateRequest(
    req: http.IncomingMessage,
  ): Promise<AuthResult> {
    const cookieToken = this.readCookie(req, BROWSER_SESSION_COOKIE_NAME);
    if (!cookieToken) return { kind: "none" };
    if (cookieToken === this.browserBootstrapToken) {
      return { kind: "bootstrap" };
    }
    const device = await this.deviceStore.matchToken(cookieToken);
    if (device) {
      return {
        kind: "device",
        deviceId: device.id,
        deviceLabel: device.label,
      };
    }
    return { kind: "none" };
  }

  private recordDeviceActivity(auth: AuthResult): Promise<void> {
    if (auth.kind !== "device") return Promise.resolve();
    return this.deviceStore.touchLastSeen(auth.deviceId).catch(() => undefined);
  }

  private async handleLeaseRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayClientLeaseRequest;
      if (!body || typeof body.clientId !== "string" || !body.clientId.trim()) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }

      const now = Date.now();
      const ttlMs =
        typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
          ? Math.max(5_000, Math.min(body.ttlMs, 120_000))
          : 30_000;
      const leaseExpiresAtMs = now + ttlMs;
      const clientId = body.clientId.trim();
      this.activeClientLeases.set(clientId, leaseExpiresAtMs);
      this.lastLeaseActivityAtMs = now;
      logHelper(
        `lease clientId=${clientId} ttlMs=${ttlMs} activeLeases=${this.getActiveLeaseCount()} expiresAt=${new Date(leaseExpiresAtMs).toISOString()}`,
      );

      await this.writeDiscovery();

      writeJson(res, 200, {
        ok: true,
        clientId,
        leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
      });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleReleaseRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayClientReleaseRequest;
      if (!body || typeof body.clientId !== "string" || !body.clientId.trim()) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }

      const clientId = body.clientId.trim();
      this.activeClientLeases.delete(clientId);
      let ownerRegistration;
      if (
        typeof body.ownerId === "string" &&
        body.ownerId.trim() &&
        typeof body.ownerGenerationId === "string" &&
        body.ownerGenerationId.trim()
      ) {
        const current = this.coreOwnerRegistry.get(body.ownerId.trim());
        if (current?.ownerGenerationId === body.ownerGenerationId.trim()) {
          ownerRegistration = this.coreOwnerRegistry.markDisconnected(
            body.ownerId.trim(),
          );
          this.askAgentMemoryRuntimeByOwner.delete(body.ownerId.trim());
        }
      }
      this.lastLeaseActivityAtMs = Date.now();
      logHelper(
        `release clientId=${clientId} activeLeases=${this.getActiveLeaseCount()}`,
      );
      await this.writeDiscovery();

      writeJson(res, 200, { ok: true, ownerRegistration });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleCoreOwnerRegisterRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayCoreOwnerLeaseRegistration | null;
      if (!this.isValidCoreOwnerRegistration(body)) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const now = Date.now();
      const registration = this.coreOwnerRegistry.registerWithCollisionPolicy({
        ...body,
        ownerId: body.ownerId.trim(),
        displayName: body.displayName.trim(),
        ownerGenerationId: body.ownerGenerationId.trim(),
        instanceId: body.instanceId?.trim() || undefined,
        processId: body.processId,
        now,
      });
      if (body.memoryRuntime) {
        this.askAgentMemoryRuntimeByOwner.set(
          registration.effectiveOwnerId,
          body.memoryRuntime,
        );
      } else {
        this.askAgentMemoryRuntimeByOwner.delete(registration.effectiveOwnerId);
      }
      this.dataPlaneRoutes.ownerRegistered(
        registration.effectiveOwnerId,
        registration.registration.ownerGenerationId,
      );
      this.commandRoutes.ownerRegistered(
        registration.effectiveOwnerId,
        registration.registration.ownerGenerationId,
      );
      this.relayStore.ownerRegistered(
        registration.effectiveOwnerId,
        registration.registration.ownerGenerationId,
      );
      this.relayRoutes.ownerRegistered(
        registration.effectiveOwnerId,
        registration.registration.ownerGenerationId,
      );
      this.lastLeaseActivityAtMs = now;
      logHelper(
        `core-owner register requestedOwnerId=${registration.requestedOwnerId} effectiveOwnerId=${registration.effectiveOwnerId} resolution=${registration.resolution} generation=${registration.registration.ownerGenerationId} kind=${registration.registration.owner.ownerKind}`,
      );
      writeJson(res, 200, {
        ok: true,
        helperGenerationId: this.helperGenerationId,
        requestedOwnerId: registration.requestedOwnerId,
        effectiveOwnerId: registration.effectiveOwnerId,
        resolution: registration.resolution,
        ownerRegistration: registration.registration,
        dataPlaneFeatures: [...BROWSER_GATEWAY_DATA_PLANE_FEATURES],
      });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleCoreOwnerHeartbeatRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayCoreOwnerHeartbeatRequest | null;
      if (
        !body ||
        typeof body.ownerId !== "string" ||
        !body.ownerId.trim() ||
        typeof body.ownerGenerationId !== "string" ||
        !body.ownerGenerationId.trim() ||
        !this.isCoreCapabilities(body.capabilities) ||
        !this.isMemoryRuntimeDescriptor(body.memoryRuntime)
      ) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const ownerRegistration = this.coreOwnerRegistry.heartbeat({
        ownerId: body.ownerId.trim(),
        ownerGenerationId: body.ownerGenerationId.trim(),
        capabilities: body.capabilities,
        now: Date.now(),
      });
      if (!ownerRegistration) {
        writeJson(res, 404, { error: "owner_not_registered" });
        return;
      }
      if (body.memoryRuntime) {
        this.askAgentMemoryRuntimeByOwner.set(
          body.ownerId.trim(),
          body.memoryRuntime,
        );
      } else {
        this.askAgentMemoryRuntimeByOwner.delete(body.ownerId.trim());
      }
      this.relayRoutes.ownerCatalogChanged();
      writeJson(res, 200, { ok: true, ownerRegistration });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private handleCoreOwnersListRequest(res: http.ServerResponse): void {
    const now = Date.now();
    writeJson(res, 200, {
      now,
      owners: this.coreOwnerRegistry.list(now),
    });
  }

  private isValidCoreOwnerRegistration(
    body: BrowserGatewayCoreOwnerLeaseRegistration | null,
  ): body is BrowserGatewayCoreOwnerLeaseRegistration {
    return Boolean(
      body &&
      typeof body.ownerId === "string" &&
      body.ownerId.trim() &&
      this.isCoreHostKind(body.ownerKind) &&
      typeof body.displayName === "string" &&
      body.displayName.trim() &&
      typeof body.ownerGenerationId === "string" &&
      body.ownerGenerationId.trim() &&
      this.isCoreSessionScope(body.scope) &&
      this.isCoreCapabilities(body.capabilities) &&
      this.isMemoryRuntimeDescriptor(body.memoryRuntime),
    );
  }

  private isMemoryRuntimeDescriptor(
    value: unknown,
  ): value is BrowserGatewayMemoryRuntimeDescriptor | undefined {
    if (value === undefined) return true;
    if (!value || typeof value !== "object") return false;
    const descriptor = value as Partial<BrowserGatewayMemoryRuntimeDescriptor>;
    return Boolean(
      (descriptor.mode === "off" || descriptor.mode === "autonomous") &&
      typeof descriptor.retrievalStoreRoot === "string" &&
      descriptor.retrievalStoreRoot.trim() &&
      path.isAbsolute(descriptor.retrievalStoreRoot),
    );
  }

  private isCoreCapabilities(
    value: unknown,
  ): value is CoreCapabilityStatusDto[] | undefined {
    if (value === undefined) return true;
    if (!Array.isArray(value)) return false;
    return value.every(
      (capability) =>
        capability !== null &&
        typeof capability === "object" &&
        typeof capability.capabilityId === "string" &&
        Boolean(capability.capabilityId.trim()) &&
        (capability.state === "enabled" ||
          capability.state === "disabled" ||
          capability.state === "requires_approval" ||
          capability.state === "unavailable") &&
        (capability.reason === undefined ||
          typeof capability.reason === "string"),
    );
  }

  private isCoreHostKind(value: unknown): value is CoreHostKind {
    return (
      typeof value === "string" && CORE_HOST_KINDS.has(value as CoreHostKind)
    );
  }

  private isCoreSessionScope(value: unknown): value is CoreSessionScopeDto {
    if (!value || typeof value !== "object") return false;
    const scope = value as Partial<CoreSessionScopeDto>;
    if (scope.kind === "workspace") {
      return Boolean(
        typeof scope.workspaceId === "string" &&
        scope.workspaceId.trim() &&
        typeof scope.displayName === "string" &&
        scope.displayName.trim(),
      );
    }
    if (scope.kind === "projectless") {
      return Boolean(
        typeof scope.scopeId === "string" &&
        scope.scopeId.trim() &&
        typeof scope.displayName === "string" &&
        scope.displayName.trim(),
      );
    }
    return false;
  }

  private async handleModelCatalogPublishRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayModelCatalogPublishRequest | null;
      if (!this.isValidModelCatalogPublishRequest(body)) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      if (body.helperGenerationId !== this.helperGenerationId) {
        writeJson(res, 409, { error: "helper_generation_mismatch" });
        return;
      }
      const owner = this.coreOwnerRegistry.get(body.publishedByOwnerId.trim());
      if (!owner) {
        writeJson(res, 409, { error: "owner_not_registered" });
        return;
      }
      if (
        owner.status !== "connected" ||
        owner.ownerGenerationId !== body.publishedByOwnerGenerationId.trim()
      ) {
        writeJson(res, 409, { error: "owner_generation_mismatch" });
        return;
      }
      const publishedAt = Date.now();
      const candidateSnapshot: BrowserGatewayPrivateModelCatalogSnapshot = {
        publishedByOwnerId: body.publishedByOwnerId.trim(),
        publishedByOwnerGenerationId: body.publishedByOwnerGenerationId.trim(),
        publishedAt,
        models: body.models.map((model) => ({
          ...model,
          id: model.id.trim(),
          displayName: model.displayName.trim(),
          providerId: model.providerId.trim(),
        })),
        openAiCompatibleRuntimeProfiles:
          body.openAiCompatibleRuntimeProfiles ?? {},
        promptProfileResolutions: body.promptProfileResolutions ?? {},
      };
      this.modelCatalogSnapshots.set(
        candidateSnapshot.publishedByOwnerId,
        candidateSnapshot,
      );
      this.latestModelCatalogOwnerId = candidateSnapshot.publishedByOwnerId;
      if (
        !this.askAgentModelOwnerId ||
        this.askAgentModelOwnerId === candidateSnapshot.publishedByOwnerId
      ) {
        this.applyModelCatalogForOwner(candidateSnapshot.publishedByOwnerId);
      }
      this.logAskAgentEvent("model-catalog.published", {
        ownerId: candidateSnapshot.publishedByOwnerId,
        modelCount: candidateSnapshot.models.length,
      });
      const response = this.buildAskAgentSnapshotResponse(
        publishedAt,
        await this.resolveInitialTheme(null),
      );
      await this.publishAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, {
        ok: true,
        publishedAt,
        modelCount: candidateSnapshot.models.length,
      });
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private isValidModelCatalogPublishRequest(
    body: BrowserGatewayModelCatalogPublishRequest | null,
  ): body is BrowserGatewayModelCatalogPublishRequest {
    return Boolean(
      body &&
      typeof body.publishedByOwnerId === "string" &&
      body.publishedByOwnerId.trim() &&
      typeof body.publishedByOwnerGenerationId === "string" &&
      body.publishedByOwnerGenerationId.trim() &&
      typeof body.helperGenerationId === "string" &&
      body.helperGenerationId.trim() &&
      Array.isArray(body.models) &&
      body.models.length > 0 &&
      body.models.every((model) => this.isValidModelCatalogEntry(model)) &&
      this.isValidOpenAiCompatibleRuntimeProfiles(
        body.openAiCompatibleRuntimeProfiles,
        body.models,
      ) &&
      this.isValidPromptProfileResolutions(
        body.promptProfileResolutions,
        body.models,
      ),
    );
  }

  private isValidModelCatalogEntry(
    value: unknown,
  ): value is CoreModelCatalogEntry {
    if (!value || typeof value !== "object") return false;
    const model = value as Partial<CoreModelCatalogEntry>;
    return Boolean(
      typeof model.id === "string" &&
      model.id.trim() &&
      typeof model.displayName === "string" &&
      model.displayName.trim() &&
      typeof model.providerId === "string" &&
      model.providerId.trim() &&
      typeof model.contextWindow === "number" &&
      Number.isFinite(model.contextWindow) &&
      model.contextWindow > 0 &&
      typeof model.authenticated === "boolean" &&
      (model.reasoningEfforts === undefined ||
        (Array.isArray(model.reasoningEfforts) &&
          model.reasoningEfforts.every(isCoreReasoningEffort))) &&
      (model.defaultReasoningEffort === undefined ||
        isCoreReasoningEffort(model.defaultReasoningEffort)),
    );
  }

  private isValidPromptProfileResolutions(
    value: BrowserGatewayPromptProfileResolutions | undefined,
    models: readonly CoreModelCatalogEntry[],
  ): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const advertisedProviders = new Map(
      models.map((model) => [
        model.id,
        normalizeBrowserGatewayModelCredentialProviderId(model.providerId),
      ]),
    );
    return Object.entries(value).every(
      ([modelId, resolution]) =>
        advertisedProviders.get(modelId) === resolution.providerId &&
        resolution.modelId === modelId &&
        isCurrentPromptProfileResolution(resolution),
    );
  }

  private isValidOpenAiCompatibleRuntimeProfiles(
    value: BrowserGatewayOpenAiCompatibleRuntimeProfiles | undefined,
    models: readonly CoreModelCatalogEntry[],
  ): boolean {
    if (value === undefined) {
      return !models.some((model) =>
        model.providerId.startsWith("openai-compatible:"),
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const modelProviders = new Map(
      models.map((model) => [model.id, model.providerId] as const),
    );
    const customProviderIds = new Set(
      models
        .filter((model) => model.providerId.startsWith("openai-compatible:"))
        .map((model) => model.providerId),
    );
    if (
      Object.keys(value).some(
        (providerId) => !customProviderIds.has(providerId),
      )
    ) {
      return false;
    }
    for (const providerId of customProviderIds) {
      const profile = value[providerId];
      if (!profile || !this.isValidOpenAiCompatibleRuntimeProfile(profile)) {
        return false;
      }
      if (profile.providerId !== providerId) return false;
      const expectedModelIds = models
        .filter((model) => model.providerId === providerId)
        .map((model) => model.id)
        .sort();
      const profileModelIds = Object.keys(profile.models).sort();
      if (
        expectedModelIds.length !== profileModelIds.length ||
        expectedModelIds.some(
          (modelId, index) =>
            modelId !== profileModelIds[index] ||
            modelProviders.get(modelId) !== providerId,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  private isValidOpenAiCompatibleRuntimeProfile(
    value: unknown,
  ): value is OpenAiCompatibleRuntimeProfile {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const profile = value as Partial<OpenAiCompatibleRuntimeProfile>;
    const allowedKeys = new Set([
      "providerId",
      "baseUrl",
      "profile",
      "headers",
      "timeoutMs",
      "authRequired",
      "models",
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
    let baseUrl: URL;
    try {
      baseUrl = new URL(String(profile.baseUrl));
    } catch {
      return false;
    }
    if (
      (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      return false;
    }
    if (
      typeof profile.providerId !== "string" ||
      !profile.providerId.startsWith("openai-compatible:") ||
      (profile.profile !== "generic" && profile.profile !== "openrouter") ||
      typeof profile.timeoutMs !== "number" ||
      !Number.isFinite(profile.timeoutMs) ||
      profile.timeoutMs < 1_000 ||
      profile.timeoutMs > 600_000 ||
      typeof profile.authRequired !== "boolean" ||
      !profile.models ||
      typeof profile.models !== "object" ||
      Array.isArray(profile.models)
    ) {
      return false;
    }
    if (profile.headers !== undefined) {
      if (
        !profile.headers ||
        typeof profile.headers !== "object" ||
        Array.isArray(profile.headers) ||
        Object.keys(profile.headers).length > 32
      ) {
        return false;
      }
      const forbidden =
        /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
      for (const [name, headerValue] of Object.entries(profile.headers)) {
        if (
          !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(name) ||
          forbidden.test(name) ||
          typeof headerValue !== "string" ||
          headerValue.length > 8_192 ||
          headerValue.includes("\r") ||
          headerValue.includes("\n") ||
          headerValue.includes("\0")
        ) {
          return false;
        }
      }
    }
    for (const [modelId, model] of Object.entries(profile.models)) {
      if (
        !model ||
        typeof model !== "object" ||
        Array.isArray(model) ||
        Object.keys(model).some(
          (key) => !["id", "model", "capabilities"].includes(key),
        ) ||
        model.id !== modelId ||
        typeof model.model !== "string" ||
        !model.model.trim() ||
        model.model.length > 1_024 ||
        !model.capabilities ||
        typeof model.capabilities !== "object"
      ) {
        return false;
      }
    }
    return true;
  }

  private async handleModelCredentialGrantRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayModelCredentialGrantRequest | null;
      if (!this.isValidModelCredentialGrantRequest(body)) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      if (body.helperGenerationId !== this.helperGenerationId) {
        writeJson(res, 409, { error: "helper_generation_mismatch" });
        return;
      }
      const owner = this.coreOwnerRegistry.get(body.grantedByOwnerId.trim());
      if (
        !owner ||
        owner.status !== "connected" ||
        owner.ownerGenerationId !== body.grantedByOwnerGenerationId.trim()
      ) {
        writeJson(res, 409, { error: "owner_generation_mismatch" });
        return;
      }
      const now = Date.now();
      const ttlMs =
        typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
          ? Math.max(5_000, Math.min(body.ttlMs, 24 * 60 * 60_000))
          : 24 * 60 * 60_000;
      const credential = this.modelCredentialCache.grant({
        providerId: body.providerId.trim(),
        method: body.method,
        bearerToken: body.bearerToken.trim(),
        grantedByOwnerId: body.grantedByOwnerId.trim(),
        grantedByOwnerGenerationId: body.grantedByOwnerGenerationId.trim(),
        modelScopes: body.modelScopes.map((scope) => scope.trim()),
        helperGenerationId: body.helperGenerationId.trim(),
        ttlMs,
        accountId: body.accountId?.trim() || undefined,
        accountLabel: body.accountLabel?.trim() || undefined,
        canRefresh: body.canRefresh === true,
        now,
      });
      writeJson(res, 200, {
        ok: true,
        credential: {
          providerId: credential.providerId,
          method: credential.method,
          modelScopes: credential.modelScopes,
          grantedByOwnerId: credential.grantedByOwnerId,
          grantedAt: credential.grantedAt,
          expiresAt: credential.expiresAt,
          accountLabel: credential.accountLabel,
          canRefresh: credential.canRefresh,
        },
      });
      const response = this.buildAskAgentSnapshotResponse(
        now,
        await this.resolveInitialTheme(null),
      );
      await this.publishAskAgentSnapshot(response.snapshot);
    } catch (err) {
      const invalidJson =
        err instanceof Error && err.message === "invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleModelCredentialClearRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req).catch(
      () => null,
    )) as BrowserGatewayModelCredentialClearRequest | null;
    if (
      !body ||
      typeof body.grantedByOwnerId !== "string" ||
      !body.grantedByOwnerId.trim() ||
      typeof body.grantedByOwnerGenerationId !== "string" ||
      !body.grantedByOwnerGenerationId.trim() ||
      (body.providerId !== undefined &&
        (typeof body.providerId !== "string" || !body.providerId.trim()))
    ) {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const owner = this.coreOwnerRegistry.get(body.grantedByOwnerId.trim());
    if (
      !owner ||
      owner.status !== "connected" ||
      owner.ownerGenerationId !== body.grantedByOwnerGenerationId.trim()
    ) {
      writeJson(res, 409, { error: "owner_generation_mismatch" });
      return;
    }
    const providerId = body.providerId?.trim();
    const removed =
      this.modelCredentialCache.clear({
        grantedByOwnerId: body.grantedByOwnerId.trim(),
        grantedByOwnerGenerationId: body.grantedByOwnerGenerationId.trim(),
        providerId,
      }) !== null;
    const payload: BrowserGatewayModelCredentialClearResponse = {
      ok: true,
      removed,
      ...(providerId ? { providerId } : {}),
    };
    writeJson(res, 200, payload);
    const now = Date.now();
    const response = this.buildAskAgentSnapshotResponse(
      now,
      await this.resolveInitialTheme(null),
    );
    await this.publishAskAgentSnapshot(response.snapshot);
  }

  private async handleModelAuthLeaseRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayModelAuthLeaseRequest | null;
      if (!this.isValidModelAuthLeaseRequest(body)) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      if (
        body.helperGenerationId &&
        body.helperGenerationId !== this.helperGenerationId
      ) {
        writeJson(res, 409, { error: "helper_generation_mismatch" });
        return;
      }
      const ttlMs =
        typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
          ? Math.max(5_000, Math.min(body.ttlMs, 5 * 60_000))
          : 60_000;
      const lease = this.modelAuthLeaseStore.requestLease({
        providerId: body.providerId.trim(),
        method: body.method,
        grantedByOwnerId: body.grantedByOwnerId.trim(),
        grantedToOwnerId: body.grantedToOwnerId.trim(),
        grantedToOwnerGenerationId: body.grantedToOwnerGenerationId.trim(),
        modelScopes: body.modelScopes.map((scope) => scope.trim()),
        ttlMs,
        auditId: body.auditId?.trim() || undefined,
        now: Date.now(),
      });
      writeJson(res, 200, { ok: true, lease });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "browser_gateway_core_owner_unavailable") {
        writeJson(res, 404, { error: "owner_not_connected" });
        return;
      }
      if (
        message === "browser_gateway_model_auth_lease_owner_generation_mismatch"
      ) {
        writeJson(res, 409, { error: "owner_generation_mismatch" });
        return;
      }
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleModelAuthLeaseValidateRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayModelAuthLeaseValidationRequest | null;
      if (!this.isValidModelAuthLeaseValidationRequest(body)) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const validation = this.modelAuthLeaseStore.validateLease({
        leaseId: body.leaseId.trim(),
        ownerId: body.ownerId.trim(),
        ownerGenerationId: body.ownerGenerationId.trim(),
        modelScope: body.modelScope.trim(),
        now: Date.now(),
      });
      writeJson(res, 200, { ok: true, validation });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleModelAuthLeaseRevokeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayModelAuthLeaseRevokeRequest | null;
      if (!body || typeof body.leaseId !== "string" || !body.leaseId.trim()) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const lease = this.modelAuthLeaseStore.revokeLease(
        body.leaseId.trim(),
        Date.now(),
      );
      writeJson(res, 200, { ok: true, lease });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private isValidModelCredentialGrantRequest(
    body: BrowserGatewayModelCredentialGrantRequest | null,
  ): body is BrowserGatewayModelCredentialGrantRequest {
    return Boolean(
      body &&
      typeof body.providerId === "string" &&
      body.providerId.trim() &&
      (body.method === "oauth" || body.method === "apiKey") &&
      typeof body.bearerToken === "string" &&
      body.bearerToken.trim() &&
      typeof body.grantedByOwnerId === "string" &&
      body.grantedByOwnerId.trim() &&
      typeof body.grantedByOwnerGenerationId === "string" &&
      body.grantedByOwnerGenerationId.trim() &&
      typeof body.helperGenerationId === "string" &&
      body.helperGenerationId.trim() &&
      Array.isArray(body.modelScopes) &&
      body.modelScopes.some(
        (scope) => typeof scope === "string" && scope.trim(),
      ),
    );
  }

  private isValidModelAuthLeaseRequest(
    body: BrowserGatewayModelAuthLeaseRequest | null,
  ): body is BrowserGatewayModelAuthLeaseRequest {
    return Boolean(
      body &&
      typeof body.providerId === "string" &&
      body.providerId.trim() &&
      (body.method === "oauth" || body.method === "apiKey") &&
      typeof body.grantedByOwnerId === "string" &&
      body.grantedByOwnerId.trim() &&
      typeof body.grantedToOwnerId === "string" &&
      body.grantedToOwnerId.trim() &&
      typeof body.grantedToOwnerGenerationId === "string" &&
      body.grantedToOwnerGenerationId.trim() &&
      typeof body.helperGenerationId === "string" &&
      body.helperGenerationId.trim() &&
      Array.isArray(body.modelScopes) &&
      body.modelScopes.some(
        (scope) => typeof scope === "string" && scope.trim(),
      ),
    );
  }

  private isValidModelAuthLeaseValidationRequest(
    body: BrowserGatewayModelAuthLeaseValidationRequest | null,
  ): body is BrowserGatewayModelAuthLeaseValidationRequest {
    return Boolean(
      body &&
      typeof body.leaseId === "string" &&
      body.leaseId.trim() &&
      typeof body.ownerId === "string" &&
      body.ownerId.trim() &&
      typeof body.ownerGenerationId === "string" &&
      body.ownerGenerationId.trim() &&
      typeof body.modelScope === "string" &&
      body.modelScope.trim(),
    );
  }

  private async handlePairingCreate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayPairingCreateRequest | null;
      const label =
        body && typeof body.label === "string"
          ? body.label.trim().slice(0, 200)
          : undefined;
      const pairing = this.pairingBroker.create({ label });

      const urls = this.buildPairingUrls();
      const response: BrowserGatewayPairingCreateResponse = {
        pairingId: pairing.pairingId,
        code: pairing.code,
        expiresAt: new Date(pairing.expiresAt).toISOString(),
        pairingUrls: urls,
      };
      writeJson(res, 200, response);
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handlePairingCancel(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayPairingCancelRequest | null;
      if (!body || typeof body.pairingId !== "string") {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      this.pairingBroker.cancel(body.pairingId);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handlePairingStatus(
    requestUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const id = requestUrl.searchParams.get("id");
    if (!id) {
      writeJson(res, 400, { error: "missing_id" });
      return;
    }
    const status = this.pairingBroker.getStatus(id);
    if (!status) {
      const notFound: BrowserGatewayPairingStatusResponse = {
        pairingId: id,
        status: "expired",
        expiresAt: new Date(0).toISOString(),
      };
      writeJson(res, 200, notFound);
      return;
    }
    writeJson(res, 200, status);
  }

  private async handleDevicesList(res: http.ServerResponse): Promise<void> {
    const devices = await this.deviceStore.list();
    const response: BrowserGatewayDevicesListResponse = { devices };
    writeJson(res, 200, response);
  }

  private async handleDevicesRevoke(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayDeviceRevokeRequest | null;
      if (!body || typeof body.deviceId !== "string") {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const removed = await this.deviceStore.revoke(body.deviceId);
      if (removed) {
        this.relayRoutes.closeDevice(body.deviceId);
        this.commandRoutes.closeSession(`device:${body.deviceId}`);
      }
      writeJson(res, 200, { ok: true, removed });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handlePairingPageGet(
    res: http.ServerResponse,
    errorMessage: string | null,
  ): Promise<void> {
    writeHtml(res, 200, this.renderPairingHtml(errorMessage));
  }

  private async handlePairingPagePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let code = "";
    const contentType = req.headers["content-type"] ?? "";
    try {
      if (contentType.includes("application/json")) {
        const body = (await readJsonBody(req)) as { code?: unknown };
        code = typeof body?.code === "string" ? body.code : "";
      } else {
        const form = await readFormBody(req);
        code = form.code ?? "";
      }
    } catch {
      writeHtml(res, 400, this.renderPairingHtml("Invalid request."));
      return;
    }

    const remote = req.socket.remoteAddress ?? "unknown";
    const attemptResult = this.pairingBroker.attempt(code, remote);
    if (!attemptResult.ok) {
      const reasonText =
        attemptResult.reason === "rate_limited"
          ? "Too many attempts. Try again in a few minutes."
          : attemptResult.reason === "expired"
            ? "That code has expired. Generate a new one in the AgentLink chat."
            : "That code isn't valid. Check the characters and try again.";
      writeHtml(res, 401, this.renderPairingHtml(reasonText));
      return;
    }

    const deviceLabel =
      attemptResult.label ??
      this.buildDefaultDeviceLabel(
        req.headers["user-agent"] ?? "Unknown device",
        remote,
      );
    const { token, device } = await this.deviceStore.register(deviceLabel);
    this.pairingBroker.markConsumed(
      attemptResult.pairingId,
      device.id,
      device.label,
    );

    const destination = "/";
    res.writeHead(303, {
      Location: destination,
      "Set-Cookie": this.buildDeviceCookie(token),
      "Cache-Control": "no-store",
    });
    res.end();
  }

  private buildDefaultDeviceLabel(userAgent: string, remote: string): string {
    const shortened = userAgent.slice(0, 80);
    const normalizedRemote = remote.startsWith("::ffff:")
      ? remote.slice(7)
      : remote;
    return `${shortened} (${normalizedRemote})`;
  }

  private buildPairingUrls(): string[] {
    const urls = new Set<string>();
    if (this.mdnsState.enabled && this.mdnsState.url) {
      urls.add(`${this.mdnsState.url}/pair`);
    }
    for (const url of listLanIpv4UrlsForPort(this.options.port)) {
      urls.add(`${url}/pair`);
    }
    // Always include loopback as a last-resort debug URL.
    urls.add(`http://127.0.0.1:${this.options.port}/pair`);
    return Array.from(urls);
  }

  private async startMdnsAdvertiser(): Promise<void> {
    const advertiser =
      this.mdnsAdvertiser ??
      new MdnsAdvertiser({
        desiredName: this.options.mdnsName ?? DEFAULT_MDNS_NAME,
        port: this.options.port,
        log: (message) => process.stdout.write(`${message}\n`),
      });
    this.mdnsAdvertiser = advertiser;
    try {
      const state = await advertiser.start();
      this.mdnsState = {
        enabled: true,
        hostName: state.hostName,
        url: state.urls[0],
      };
    } catch (err) {
      process.stderr.write(
        `[mdns] failed to start — falling back to IP access only: ${String(err)}\n`,
      );
      this.mdnsState = { enabled: false };
      this.mdnsAdvertiser = null;
    }
  }

  private handleAskAgentTurnChanged(active: boolean): void {
    if (active) {
      this.releaseAskAgentTurnLiveness?.();
      this.releaseAskAgentTurnLiveness =
        this.lifecycle.acquireLiveness("ask_agent_turn");
      return;
    }
    this.releaseAskAgentTurnLiveness?.();
    this.releaseAskAgentTurnLiveness = undefined;
  }

  private handleLivenessChanged(
    reasons: readonly HelperLivenessReason[],
  ): void {
    this.lastLeaseActivityAtMs = Date.now();
    this.logAskAgentEvent("helper.liveness.changed", {
      reasons: reasons.join(","),
      activeBrowserStreams: this.lifecycle.activeStreamCount,
    });
  }

  private getActiveLeaseCount(nowMs = Date.now()): number {
    for (const [clientId, expiresAt] of this.activeClientLeases) {
      if (expiresAt <= nowMs) {
        this.activeClientLeases.delete(clientId);
      }
    }
    return this.activeClientLeases.size;
  }

  private shouldShutdownForIdle(nowMs: number): boolean {
    if (this.shuttingDown) return false;
    if (this.getActiveLeaseCount(nowMs) > 0) return false;
    if (this.lifecycle.hasLivenessReasons()) return false;
    return nowMs - this.lastLeaseActivityAtMs >= this.options.idleShutdownMs;
  }

  private async maybeShutdownForIdle(): Promise<void> {
    if (!this.shouldShutdownForIdle(Date.now())) return;
    await this.stop("idle");
    process.exit(0);
  }

  private async resolveEffectiveDataPlaneMode(): Promise<BrowserGatewayDataPlaneMode> {
    return this.resolveEffectiveDataPlaneModeFromInstances(
      await listRegisteredBrowserGatewayInstances(),
    );
  }

  private resolveEffectiveDataPlaneModeFromInstances(
    instances: readonly Pick<BrowserGatewayInstanceRecord, "dataPlaneMode">[],
  ): BrowserGatewayDataPlaneMode {
    const { mode, missingCount, invalidCount } =
      resolveRegisteredBrowserGatewayDataPlaneModes(
        instances.map((instance) => instance.dataPlaneMode),
      );
    const fallbackFingerprint = `${missingCount}:${invalidCount}`;
    if (
      (missingCount > 0 || invalidCount > 0) &&
      fallbackFingerprint !== this.dataPlaneModeFallbackFingerprint
    ) {
      logHelper(
        `data-plane mode fallback effective=off missing=${missingCount} invalid=${invalidCount} reason=version-skew-or-stale-registry`,
      );
    }
    this.dataPlaneModeFallbackFingerprint =
      missingCount > 0 || invalidCount > 0 ? fallbackFingerprint : undefined;
    return mode;
  }

  private async writeDiscovery(): Promise<void> {
    const lanUrls = this.options.lanAccess
      ? listLanIpv4UrlsForPort(this.options.port)
      : [];
    const dataPlaneMode = await this.resolveEffectiveDataPlaneMode();
    const record: BrowserGatewayHelperDiscoveryRecord = {
      pid: process.pid,
      port: this.options.port,
      url: `http://127.0.0.1:${this.options.port}`,
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: this.startedAt.toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      helperVersion: this.options.helperVersion,
      helperGenerationId: this.helperGenerationId,
      dataPlaneMode,
      dataPlaneFeatures: [...BROWSER_GATEWAY_DATA_PLANE_FEATURES],
      browserBootstrapToken: this.browserBootstrapToken,
      clientSharedSecret: this.clientSharedSecret,
      lanAccess: Boolean(this.options.lanAccess),
      mdnsHostName: this.mdnsState.hostName,
      mdnsUrl: this.mdnsState.url,
      lanUrls,
    };
    await writeBrowserGatewayHelperDiscovery(record);
  }

  private async handleAppIconRequest(res: http.ServerResponse): Promise<void> {
    try {
      const iconPath = path.join(
        this.options.extensionRootPath,
        "media",
        "icon.png",
      );
      const content = await fs.readFile(iconPath);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-cache",
        ETag: JSON.stringify(`${this.options.helperVersion}:media/icon.png`),
        "X-AgentLink-Helper-Version": this.options.helperVersion,
      });
      res.end(content);
    } catch {
      writeJson(res, 404, { error: "not_found" });
    }
  }

  private handleWebManifestRequest(res: http.ServerResponse): void {
    writeJson(
      res,
      200,
      {
        name: "AgentLink Remote",
        short_name: "AgentLink",
        description: "Remote control surface for AgentLink.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#1e1e1e",
        theme_color: "#4EC9B0",
        icons: [
          {
            src: AGENTLINK_ICON_SVG_PATH,
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: AGENTLINK_ICON_PATH,
            sizes: AGENTLINK_ICON_SIZES,
            type: "image/png",
            purpose: "any",
          },
        ],
      },
      {
        "Content-Type": "application/manifest+json; charset=utf-8",
      },
    );
  }

  private async handleStaticAssetRequest(
    relativePath: string,
    contentType: string,
    res: http.ServerResponse,
    cacheControl = "no-cache",
  ): Promise<void> {
    try {
      const assetPath = path.join(this.options.extensionRootPath, relativePath);
      const content = await fs.readFile(assetPath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        ETag: JSON.stringify(`${this.options.helperVersion}:${relativePath}`),
        "X-AgentLink-Helper-Version": this.options.helperVersion,
      });
      res.end(content);
    } catch {
      writeJson(res, 404, { error: "not_found" });
    }
  }

  private renderIndexHtml(
    currentInstanceId: string,
    workspaceName: string,
    initialTheme: BrowserGatewayThemeSnapshot,
    dataPlaneMode: BrowserGatewayDataPlaneMode,
  ): string {
    const assetVersion = encodeURIComponent(this.options.helperVersion);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="application-name" content="AgentLink Remote">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="AgentLink">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#4EC9B0">
  <title>AgentLink Browser Gateway</title>
  ${renderThemeStyleTag(initialTheme)}
  <link rel="icon" type="image/svg+xml" href="${AGENTLINK_ICON_SVG_PATH}?v=${assetVersion}">
  <link rel="icon" type="image/png" sizes="${AGENTLINK_ICON_SIZES}" href="${AGENTLINK_ICON_PATH}?v=${assetVersion}">
  <link rel="apple-touch-icon" sizes="${AGENTLINK_ICON_SIZES}" href="/apple-touch-icon.png?v=${assetVersion}">
  <link rel="manifest" href="/site.webmanifest?v=${assetVersion}">
  <link rel="stylesheet" href="/codicon.css?v=${assetVersion}">
  <link rel="stylesheet" href="/browser-gateway.css?v=${assetVersion}">
</head>
<body>
  <div id="root"></div>
  <script>
    window.__AGENTLINK_BROWSER_GATEWAY__ = {
      authToken: "",
      currentInstanceId: ${JSON.stringify(currentInstanceId)},
      workspaceName: ${JSON.stringify(workspaceName)},
      routeByInstance: true,
      initialTheme: ${JSON.stringify(initialTheme)},
      dataPlaneMode: ${JSON.stringify(dataPlaneMode)}
    };
  </script>
  <script type="module" src="/browser-gateway.js?v=${assetVersion}"></script>
</body>
</html>`;
  }

  private renderPairingHtml(errorMessage: string | null): string {
    const errorBlock = errorMessage
      ? `<p class="pair-error" role="alert">${htmlEscape(errorMessage)}</p>`
      : "";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pair with AgentLink</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #1e1e1e;
      color: #d4d4d4;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .pair-card {
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 12px;
      padding: 32px 28px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35);
    }
    .pair-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #4EC9B0;
      margin-bottom: 18px;
    }
    .pair-brand .dot { width: 10px; height: 10px; border-radius: 50%; background: #4EC9B0; }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 8px 0 16px; line-height: 1.5; font-size: 14px; color: #bbb; }
    .pair-error {
      background: rgba(244, 71, 71, 0.12);
      border: 1px solid rgba(244, 71, 71, 0.4);
      color: #f48771;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    form { display: flex; flex-direction: column; gap: 14px; margin-top: 8px; }
    input[name="code"] {
      font-size: 32px;
      letter-spacing: 8px;
      text-align: center;
      padding: 14px;
      border-radius: 10px;
      border: 1px solid #3c3c3c;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: "SF Mono", Menlo, Consolas, monospace;
    }
    input[name="code"]:focus {
      outline: none;
      border-color: #4EC9B0;
      box-shadow: 0 0 0 3px rgba(78,201,176,0.2);
    }
    button {
      font-size: 15px;
      padding: 12px;
      border-radius: 10px;
      border: 0;
      background: #4EC9B0;
      color: #111;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #5ed7bf; }
    .pair-footnote { margin-top: 12px; font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <main class="pair-card">
    <div class="pair-brand"><span class="dot"></span>AgentLink</div>
    <h1>Pair this device</h1>
    <p>Enter the 6-digit code shown in AgentLink on your computer. Codes expire after a few minutes.</p>
    ${errorBlock}
    <form method="post" action="/pair" autocomplete="off" novalidate>
      <input
        name="code"
        inputmode="numeric"
        pattern="[0-9]{6}"
        maxlength="6"
        placeholder="000000"
        autofocus
        required
      />
      <button type="submit">Pair device</button>
    </form>
    <div class="pair-footnote">After pairing, this browser stays signed in until you revoke it from the AgentLink chat.</div>
  </main>
</body>
</html>`;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const server = http.createServer();
  const helper = new BrowserGatewayHelper(options, server);
  server.on("request", helper.handleRequest);

  process.on("SIGINT", () => {
    void helper.stop("sigint").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void helper.stop("sigterm").finally(() => process.exit(0));
  });

  try {
    await helper.start();
  } catch (error) {
    process.stderr.write(
      `[browser-gateway-helper] failed to start: ${String(error)}\n`,
    );
    process.exit(1);
  }
}

function isDirectHelperEntry(): boolean {
  const entry = process.argv[1] ?? "";
  return (
    entry.endsWith("/browser-gateway-helper.js") ||
    entry.endsWith("\\browser-gateway-helper.js") ||
    entry.endsWith("/browserGatewayHelper.ts") ||
    entry.endsWith("\\browserGatewayHelper.ts")
  );
}

if (isDirectHelperEntry()) {
  void main();
}
