import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
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
  getBrowserGatewayRegistryPath,
  listCheckedBrowserGatewayInstances,
  listHealthyBrowserGatewayInstances,
  setBrowserGatewayRegistryLogger,
  type BrowserGatewayInstanceRecord,
} from "../browserGatewayRegistry.js";
import {
  BAKED_BROWSER_GATEWAY_THEME,
  readBrowserGatewayThemeCache,
} from "../browserGatewayThemeCache.js";
import {
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
  type BrowserGatewayModelCredentialClearResponse,
  type BrowserGatewayModelCredentialGrantRequest,
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
  clearBrowserGatewayHelperDiscovery,
  writeBrowserGatewayHelperDiscovery,
} from "../browserGatewayHelperDiscovery.js";
import { BrowserGatewayModelAuthLeaseStore } from "../browserGatewayModelAuthLeaseStore.js";
import {
  askAgentMediaToDisplayMedia,
  BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE,
  BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
  BrowserGatewayAskAgentSessionStore,
  type BrowserGatewayAskAgentMediaItem,
  type BrowserGatewayAskAgentMemoryCandidateNudge,
  type BrowserGatewayAskAgentPersistedSession,
  type BrowserGatewayAskAgentProjectHandoff,
} from "../browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayAskAgentPreferencesStore } from "../browserGatewayAskAgentPreferences.js";
import { BrowserGatewayAskAgentHistoryStore } from "../browserGatewayAskAgentHistory.js";
import type {
  ChatMessage,
  Question,
  ReasoningEffort,
} from "../../agent/webview/types.js";
import type { DecisionMessage } from "../../approvals/webview/types.js";
import {
  BrowserGatewayModelCredentialCache,
  type BrowserGatewayModelCredentialRecord,
} from "../browserGatewayModelCredentialCache.js";
import type {
  CoreModelMessage,
  CoreModelToolDefinition,
} from "../../core/modelRuntime.js";
import type {
  FinalMessageMarker,
  FinalMessageStatus,
} from "../../shared/finalStatus.js";
import { handleTodoWrite, type TodoToolInput } from "../../agent/todoTool.js";
import { MCP_TOOL_BRIDGE_TOOL_NAMES } from "../../shared/mcpToolDefinitions.js";
import {
  ASK_AGENT_SAFE_PROJECTLESS_TOOLS,
  ASK_AGENT_SAFE_PROJECTLESS_TOOL_NAMES,
  BrowserGatewayAskAgentModelClient,
  type BrowserGatewayAskAgentToolCall,
} from "./askAgentModelClient.js";
import {
  BrowserGatewayAskAgentMemoryStore,
  getAskAgentMemorySourceRevision,
  hasAskAgentMemoryPastIntent,
  type BrowserGatewayAskAgentMemoryChunk,
  type BrowserGatewayAskAgentMemorySearchResult,
  type BrowserGatewayAskAgentSessionMemory,
} from "../browserGatewayAskAgentMemory.js";
import {
  ASK_AGENT_TRANSCRIPT_EXCERPT_MAX_MESSAGES,
  formatAskAgentMemoryContext,
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
import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import { DeviceStore } from "./deviceStore.js";
import { PairingBroker } from "./pairingBroker.js";
import { MdnsAdvertiser, listLanIpv4UrlsForPort } from "./mdnsAdvertiser.js";
import type {
  CoreHostKind,
  CoreSessionScopeDto,
} from "../../core/sessionProtocol.js";
import type {
  CoreModelCatalogEntry,
  CoreModelCatalogSnapshot,
} from "../../core/modelCatalog.js";
import {
  MAX_MEMORY_NUDGES_PER_SESSION,
  detectMemoryCandidates,
} from "../../shared/memoryCandidates.js";

export interface HelperRuntimeOptions {
  port: number;
  helperVersion: string;
  idleShutdownMs: number;
  extensionRootPath: string;
  /** Override persistent Ask Agent diagnostics log path. Defaults under `~/.agentlink/`. */
  askAgentLogPath?: string;
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
const ASK_AGENT_LOG_FIELD_LIMIT = 32;
const ASK_AGENT_MEMORY_SUMMARY_DEBOUNCE_MS = 750;
const ASK_AGENT_MEMORY_DISCLOSURE_SOURCE_LIMIT = 5;
const ASK_AGENT_MEMORY_DISCLOSURE_SUMMARY_SOURCE_LIMIT = 3;
const ASK_AGENT_MEMORY_DISCLOSURE_TRANSCRIPT_SOURCE_LIMIT = 2;
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

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}

async function readFormBody(
  req: http.IncomingMessage,
): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

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
  if (!addr) return false;
  const normalized = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
    value,
  );
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
  stop: boolean;
  outcome?: AskAgentToolLoopOutcome;
  toolMessage?: CoreModelMessage;
  modelResult?: string;
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
  private modelCatalogSnapshot: CoreModelCatalogSnapshot | null = null;
  private readonly askAgentSessionStore: BrowserGatewayAskAgentSessionStore;
  private readonly askAgentEventClients = new Set<http.ServerResponse>();
  private readonly askAgentModelClient: Pick<
    BrowserGatewayAskAgentModelClient,
    "complete"
  > &
    Partial<Pick<BrowserGatewayAskAgentModelClient, "completeWithToolCalls">>;
  private askAgentActiveTurn: {
    messageId: string;
    controller: AbortController;
    stopped: boolean;
  } | null = null;
  private readonly askAgentLogPath: string;
  private readonly askAgentPreferencesStore: BrowserGatewayAskAgentPreferencesStore;
  private readonly askAgentHistoryStore: BrowserGatewayAskAgentHistoryStore;
  private readonly askAgentMemoryStore: BrowserGatewayAskAgentMemoryStore;
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
  private askAgentMemoryCandidateNudge: BrowserGatewayAskAgentMemoryCandidateNudge | null =
    null;
  private readonly askAgentMemoryCandidateNudgeCounts = new Map<
    string,
    number
  >();
  private readonly askAgentMemoryCandidateDismissed = new Set<string>();
  private readonly askAgentMemorySecretSkippedRevisions = new Map<
    string,
    string
  >();
  private readonly deviceStore: DeviceStore;
  private readonly pairingBroker: PairingBroker;
  private mdnsAdvertiser: MdnsAdvertiser | null = null;
  private mdnsState: BrowserGatewayMdnsState = { enabled: false };
  private idleCheckTimer: NodeJS.Timeout | undefined;
  private discoveryHeartbeatTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;
  private lastLeaseActivityAtMs = Date.now();
  private readonly bindHost: string;

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
          Pick<BrowserGatewayAskAgentModelClient, "completeWithToolCalls">
        >;
      askAgentSummarizer?: BrowserGatewayAskAgentSummarizer;
      askAgentMemoryStore?: BrowserGatewayAskAgentMemoryStore;
      askAgentMemorySummaryDebounceMs?: number;
      askAgentPreferencesStore?: BrowserGatewayAskAgentPreferencesStore;
      askAgentHistoryStore?: BrowserGatewayAskAgentHistoryStore;
    } = {},
  ) {
    this.deviceStore = injectables.deviceStore ?? new DeviceStore();
    this.pairingBroker = injectables.pairingBroker ?? new PairingBroker();
    this.mdnsAdvertiser = injectables.mdnsAdvertiser ?? null;
    this.askAgentPreferencesStore =
      injectables.askAgentPreferencesStore ??
      new BrowserGatewayAskAgentPreferencesStore();
    this.askAgentHistoryStore =
      injectables.askAgentHistoryStore ??
      new BrowserGatewayAskAgentHistoryStore();
    this.askAgentSessionStore = new BrowserGatewayAskAgentSessionStore(
      this.coreOwnerRegistry,
    );
    this.askAgentModelClient =
      injectables.askAgentModelClient ??
      new BrowserGatewayAskAgentModelClient({
        sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
      });
    this.askAgentMemoryStore =
      injectables.askAgentMemoryStore ??
      new BrowserGatewayAskAgentMemoryStore();
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

  async start(): Promise<void> {
    const [preferences, history] = await Promise.all([
      this.askAgentPreferencesStore.read(),
      this.askAgentHistoryStore.read(),
    ]);
    this.askAgentSessionStore.applyPreferences(preferences);
    this.askAgentSessionStore.loadHistory(history);
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
      void this.writeDiscovery();
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

  async stop(reason = "shutdown"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

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

    for (const client of this.askAgentEventClients) {
      client.end();
    }
    this.askAgentEventClients.clear();

    if (this.mdnsAdvertiser) {
      try {
        await this.mdnsAdvertiser.stop();
      } catch {
        // ignore
      }
      this.mdnsAdvertiser = null;
    }

    await clearBrowserGatewayHelperDiscovery();

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    this.logAskAgentEvent("helper.stopped", {
      reason,
      helperGenerationId: this.helperGenerationId,
    });

    process.stdout.write(
      JSON.stringify({
        type: "helper_stopped",
        reason,
      }) + "\n",
    );
  }

  handleRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const requestUrl = new URL(rawUrl, `http://127.0.0.1:${this.options.port}`);
    const pathname = requestUrl.pathname;

    if (method === "GET" && pathname === "/health") {
      const payload: BrowserGatewayHelperHealthResponse = {
        status: "ok",
        protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
        helperVersion: this.options.helperVersion,
        startedAt: this.startedAt.toISOString(),
        now: new Date().toISOString(),
        uptimeMs: Date.now() - this.startedAtMs,
        activeClientLeases: this.getActiveLeaseCount(),
        helperGenerationId: this.helperGenerationId,
        coreOwners: this.coreOwnerRegistry.list(Date.now()).length,
      };
      writeJson(res, 200, payload);
      return;
    }

    // Internal extension-to-helper endpoints (auth: clientSharedSecret).
    if (pathname.startsWith("/internal/")) {
      if (!this.isInternalClientAuthorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      void this.handleInternalRequest(method, pathname, req, res, requestUrl);
      return;
    }

    // Public pairing endpoints (no cookie required — that's the whole point).
    if (method === "GET" && pathname === "/pair") {
      void this.handlePairingPageGet(res, null);
      return;
    }
    if (method === "POST" && pathname === "/pair") {
      void this.handlePairingPagePost(req, res);
      return;
    }

    if (method === "GET" && pathname === "/") {
      void this.handleRootRequest(req, requestUrl, res);
      return;
    }

    if (method === "GET" && pathname === "/browser-gateway.js") {
      void this.handleStaticAssetRequest(
        "dist/browser-gateway.js",
        "text/javascript; charset=utf-8",
        res,
      );
      return;
    }

    if (method === "GET" && pathname === "/browser-gateway.css") {
      void this.handleStaticAssetRequest(
        "dist/browser-gateway.css",
        "text/css; charset=utf-8",
        res,
      );
      return;
    }

    if (method === "GET" && pathname.startsWith("/monaco-")) {
      const assetName = pathname.slice(1);
      if (/^monaco-[a-z-]+\.worker\.js$/.test(assetName)) {
        void this.handleStaticAssetRequest(
          `dist/${assetName}`,
          "text/javascript; charset=utf-8",
          res,
        );
        return;
      }
      if (/^monaco-[a-z-]+\.worker\.js\.map$/.test(assetName)) {
        void this.handleStaticAssetRequest(
          `dist/${assetName}`,
          "application/json; charset=utf-8",
          res,
        );
        return;
      }
    }

    if (method === "GET" && pathname === "/codicon.css") {
      void this.handleStaticAssetRequest(
        "dist/codicon.css",
        "text/css; charset=utf-8",
        res,
      );
      return;
    }

    if (
      method === "GET" &&
      (pathname === "/codicon.ttf" || pathname.startsWith("/codicon.ttf"))
    ) {
      void this.handleStaticAssetRequest("dist/codicon.ttf", "font/ttf", res);
      return;
    }

    if (
      method === "GET" &&
      (pathname === "/favicon.ico" ||
        pathname === AGENTLINK_ICON_PATH ||
        pathname === "/apple-touch-icon.png")
    ) {
      void this.handleAppIconRequest(res);
      return;
    }

    if (method === "GET" && pathname === AGENTLINK_ICON_SVG_PATH) {
      void this.handleStaticAssetRequest(
        "media/agentlink-terminal.svg",
        "image/svg+xml; charset=utf-8",
        res,
      );
      return;
    }

    if (method === "GET" && pathname === "/site.webmanifest") {
      this.handleWebManifestRequest(res);
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/session") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentSessionRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/sessions") {
      void this.authThen(req, res, async (auth) => {
        this.handleAskAgentSessionsRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/session/new") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentNewSessionRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/session/load") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentLoadSessionRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/session/delete") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentDeleteSessionRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/session/rename") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentRenameSessionRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/ask-agent/session/copy-first-prompt"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentCopyFirstPromptRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/events") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentEventsRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/models") {
      void this.authThen(req, res, async (auth) => {
        this.handleAskAgentModelsRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/slash-commands") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentSlashCommandsRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/mcp-config") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMcpConfigRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/mcp-config/server") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMcpConfigServerRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "DELETE" &&
      pathname === "/api/ask-agent/mcp-config/server"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMcpConfigServerRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/ask-agent/mcp-config/open-raw"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMcpConfigOpenRawRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/mcp-status") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMcpStatusRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/mcp-refresh") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMcpRefreshRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/question") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentQuestionResponseRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/question-progress") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentQuestionProgressRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/memory") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMemoryStatusRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/memory/clear") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMemoryClearRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/log") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentUiLogRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/model") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentModelRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/memory/proposal") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMemoryProposalRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/ask-agent/memory/nudge/dismiss"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMemoryCandidateNudgeDismissRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/memory/approval") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentMemoryApprovalRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/ask-agent/read-grants") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentReadGrantsRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/read-grants") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentReadGrantAddRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/read-grants/revoke") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentReadGrantRevokeRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "GET" &&
      pathname === "/api/ask-agent/project-handoff/targets"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentProjectHandoffTargetsRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/ask-agent/project-handoff/propose"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentProjectHandoffProposeRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/ask-agent/project-handoff/cancel"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentProjectHandoffCancelRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/ask-agent/project-handoff/approve"
    ) {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentProjectHandoffApproveRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/thinking") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentThinkingRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/send") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentSendRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/retry") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentRetryRequest(req, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "POST" && pathname === "/api/ask-agent/stop") {
      void this.authThen(req, res, async (auth) => {
        await this.handleAskAgentStopRequest(res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/api/instances") {
      void this.authThen(req, res, async (auth) => {
        await this.handleInstancesRequest(requestUrl, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/events") {
      void this.authThen(req, res, async (auth) => {
        await this.handleProxyRequest(req, res, requestUrl);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (pathname.startsWith("/api/")) {
      void this.authThen(req, res, async (auth) => {
        await this.handleProxyRequest(req, res, requestUrl);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    writeJson(res, 404, { error: "not_found" });
  };

  private async authThen(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (auth: AuthResult) => Promise<void>,
  ): Promise<void> {
    const auth = await this.authenticateRequest(req);
    if (auth.kind === "none") {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    await handler(auth);
  }

  private async handleInternalRequest(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    if (method === "POST" && pathname === "/internal/client/lease") {
      await this.handleLeaseRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/client/release") {
      await this.handleReleaseRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/core-owners/register") {
      await this.handleCoreOwnerRegisterRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/core-owners/heartbeat") {
      await this.handleCoreOwnerHeartbeatRequest(req, res);
      return;
    }
    if (method === "GET" && pathname === "/internal/core-owners") {
      this.handleCoreOwnersListRequest(res);
      return;
    }
    if (method === "POST" && pathname === "/internal/model-catalog") {
      await this.handleModelCatalogPublishRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/model-auth/credentials") {
      await this.handleModelCredentialGrantRequest(req, res);
      return;
    }
    if (
      method === "POST" &&
      pathname === "/internal/model-auth/credentials/clear"
    ) {
      await this.handleModelCredentialClearRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/model-auth/leases") {
      await this.handleModelAuthLeaseRequest(req, res);
      return;
    }
    if (
      method === "POST" &&
      pathname === "/internal/model-auth/leases/validate"
    ) {
      await this.handleModelAuthLeaseValidateRequest(req, res);
      return;
    }
    if (
      method === "POST" &&
      pathname === "/internal/model-auth/leases/revoke"
    ) {
      await this.handleModelAuthLeaseRevokeRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/shutdown") {
      writeJson(res, 202, { ok: true });
      setImmediate(() => {
        void this.stop("admin_shutdown");
      });
      return;
    }
    if (method === "POST" && pathname === "/internal/pairing/create") {
      await this.handlePairingCreate(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/pairing/cancel") {
      await this.handlePairingCancel(req, res);
      return;
    }
    if (method === "GET" && pathname === "/internal/pairing/status") {
      await this.handlePairingStatus(requestUrl, res);
      return;
    }
    if (method === "GET" && pathname === "/internal/devices") {
      await this.handleDevicesList(res);
      return;
    }
    if (method === "POST" && pathname === "/internal/devices/revoke") {
      await this.handleDevicesRevoke(req, res);
      return;
    }
    writeJson(res, 404, { error: "not_found" });
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
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const selectedInstance = this.selectInstance(
      healthyInstances,
      requestedInstanceId,
    );
    const enrichedInstances =
      await this.buildInstanceListItems(registeredInstances);
    logHelper(
      `/api/instances requestedInstanceId=${requestedInstanceId || "none"} selected=${selectedInstance?.instanceId ?? "none"} registered=${registeredInstances.length} healthy=${healthyInstances.length} registeredIds=${registeredInstances.map((instance) => instance.instanceId).join(",") || "none"}`,
    );

    this.writeInstancesJson(
      res,
      selectedInstance?.instanceId ?? "",
      enrichedInstances,
    );
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
    this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      if (!sessionId || !this.askAgentSessionStore.deleteSession(sessionId)) {
        writeJson(res, 404, {
          ok: false,
          error: "ask_agent_session_not_found",
          message: "Ask Agent session not found.",
        });
        return;
      }
      await this.persistAskAgentHistory();
      await this.askAgentMemoryStore.deleteSessionMemory(sessionId);
      this.cancelAskAgentMemorySummary(sessionId);
      this.clearAskAgentMemoryCandidateNudgeForSession(sessionId);
      const response = await this.buildAskAgentResponse();
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
    try {
      const body = (await readJsonBody(req)) as {
        id?: unknown;
        answers?: unknown;
        notes?: unknown;
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
      if (
        !id ||
        !this.askAgentSessionStore.answerQuestion(id, answers, notes)
      ) {
        writeJson(res, 404, {
          ok: false,
          error: "ask_agent_question_not_found",
        });
        return;
      }
      const response = await this.buildAskAgentResponse();
      this.broadcastAskAgentSnapshot(response.snapshot);
      this.logAskAgentEvent("ask-agent.question.response", { id, ok: true });
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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

  private async buildAskAgentResponse(): Promise<
    ReturnType<BrowserGatewayAskAgentSessionStore["getOrCreate"]>
  > {
    const now = Date.now();
    return this.buildAskAgentSnapshotResponse(
      now,
      await this.resolveInitialTheme(null),
    );
  }

  private readGlobalDurableMemoryContent(): string | undefined {
    const memoryPath = path.join(os.homedir(), ".agentlink", "memory.md");
    try {
      return fsSync.readFileSync(memoryPath, "utf-8");
    } catch {
      return undefined;
    }
  }

  private buildAskAgentMemoryCandidateNudgeKey(params: {
    sessionId: string;
    kind: string;
    matchedPhrase: string;
  }): string {
    return [params.sessionId, params.kind, params.matchedPhrase]
      .map((part) => part.trim().toLowerCase().replace(/\s+/g, " "))
      .join("::");
  }

  private maybeCreateAskAgentMemoryCandidateNudge(params: {
    text: string;
    priorUserTexts: string[];
    sessionId: string;
    now: number;
  }): void {
    if (this.askAgentMemoryProposalBridge.getPendingApproval()) return;
    if (this.askAgentMemoryCandidateNudge?.sessionId === params.sessionId)
      return;

    const nudgeCount =
      this.askAgentMemoryCandidateNudgeCounts.get(params.sessionId) ?? 0;
    if (nudgeCount >= MAX_MEMORY_NUDGES_PER_SESSION) return;

    const candidate = detectMemoryCandidates(
      params.text,
      params.priorUserTexts,
      this.readGlobalDurableMemoryContent(),
    ).find((item) => item.suggestedScope === "global");
    if (!candidate) return;

    const key = this.buildAskAgentMemoryCandidateNudgeKey({
      sessionId: params.sessionId,
      kind: candidate.kind,
      matchedPhrase: candidate.matchedPhrase,
    });
    if (this.askAgentMemoryCandidateDismissed.has(key)) return;

    this.askAgentMemoryCandidateNudgeCounts.set(
      params.sessionId,
      nudgeCount + 1,
    );
    this.askAgentMemoryCandidateNudge = {
      id: `ask-agent-memory-nudge-${randomUUID()}`,
      sessionId: params.sessionId,
      createdAt: params.now,
      kind: candidate.kind,
      matchedPhrase: candidate.matchedPhrase,
      suggestedScope: "global",
      suggestedTier: "memory",
      title: "Remember from Ask Agent",
      rationale:
        "Ask Agent detected a possible durable user preference. Review before saving; persistence requires explicit approval.",
      content: candidate.matchedPhrase,
    };
    this.logAskAgentEvent("ask-agent.memory.nudge.detected", {
      ok: true,
      sessionId: params.sessionId,
      kind: candidate.kind,
      nudgeCount: nudgeCount + 1,
    });
  }

  private dismissAskAgentMemoryCandidateNudge(id: string): void {
    const nudge = this.askAgentMemoryCandidateNudge;
    if (!nudge || nudge.id !== id) return;
    this.askAgentMemoryCandidateDismissed.add(
      this.buildAskAgentMemoryCandidateNudgeKey({
        sessionId: nudge.sessionId,
        kind: nudge.kind,
        matchedPhrase: nudge.matchedPhrase,
      }),
    );
    this.askAgentMemoryCandidateNudge = null;
  }

  private clearAskAgentMemoryCandidateNudgeForSession(sessionId: string): void {
    if (this.askAgentMemoryCandidateNudge?.sessionId === sessionId) {
      this.askAgentMemoryCandidateNudge = null;
    }
    this.askAgentMemoryCandidateNudgeCounts.delete(sessionId);
    const dismissedPrefix = `${sessionId.trim().toLowerCase()}::`;
    for (const key of this.askAgentMemoryCandidateDismissed) {
      if (key.startsWith(dismissedPrefix)) {
        this.askAgentMemoryCandidateDismissed.delete(key);
      }
    }
  }

  private buildAskAgentSnapshotResponse(
    now: number,
    theme: BrowserGatewayThemeSnapshot,
  ): ReturnType<BrowserGatewayAskAgentSessionStore["getOrCreate"]> {
    return this.askAgentSessionStore.getOrCreate({
      now,
      theme,
      modelCredentialStatus: this.getAskAgentModelCredentialStatus(now),
      approval: this.askAgentMemoryProposalBridge.getPendingApproval(),
      memoryCandidateNudge: this.askAgentMemoryCandidateNudge,
    });
  }

  private async persistAskAgentHistory(): Promise<void> {
    await this.askAgentHistoryStore.write(
      this.askAgentSessionStore.getHistorySnapshot(),
    );
  }

  private scheduleAskAgentMemorySummary(sessionId: string): void {
    const session = this.askAgentSessionStore
      .getHistorySnapshot()
      .sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.messages.length < 2) return;

    const credential = this.getAskAgentModelCredential(Date.now());
    if (!credential) {
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
    const credential = this.getAskAgentModelCredential(Date.now());
    if (!credential) {
      this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
        sessionId: session.id,
        reason: "credential_unavailable",
      });
      return;
    }
    const controller = new AbortController();
    this.askAgentMemorySummaryControllers.set(session.id, controller);
    try {
      const existingSnapshot = await this.askAgentMemoryStore.read();
      const existingSession = existingSnapshot.sessions.find(
        (candidate) => candidate.sessionId === session.id,
      );
      if (existingSession?.sourceRevision === revision) {
        this.logAskAgentEvent("ask-agent.memory.summary.skipped", {
          sessionId: session.id,
          reason: "unchanged_revision",
        });
        return;
      }

      const summary = await this.askAgentSummarizer.summarize({
        credential,
        model: this.askAgentSessionStore.getModel(),
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
        await this.askAgentMemoryStore.deleteSessionMemory(session.id);
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
      const sessionMemory: BrowserGatewayAskAgentSessionMemory = {
        sessionId: session.id,
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
      const chunk: BrowserGatewayAskAgentMemoryChunk = {
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
      await this.askAgentMemoryStore.update((snapshot) => {
        const sessions = snapshot.sessions.filter(
          (candidate) => candidate.sessionId !== sessionMemory.sessionId,
        );
        const chunks = snapshot.chunks.filter(
          (candidate) => candidate.id !== chunk.id,
        );
        sessions.push(sessionMemory);
        chunks.push(chunk);
        return {
          ...snapshot,
          updatedAt: Math.max(snapshot.updatedAt, now),
          sessions,
          chunks,
        };
      });
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
      const results = await this.askAgentMemoryStore.search(params.query, {
        activeSessionId: params.activeSessionId,
        recentMessageIds,
        limit: 5,
      });
      if (results.length === 0) {
        this.logAskAgentEvent("ask-agent.memory.context.omitted", {
          sessionId: params.activeSessionId,
          reason: "no_relevant_memory",
        });
        return undefined;
      }
      const memoryContext = formatAskAgentMemoryContext(results);
      const transcriptExcerpts = hasAskAgentMemoryPastIntent(params.query)
        ? await this.buildAskAgentTranscriptExcerpts({
            results,
            activeSessionId: params.activeSessionId,
            recentMessageIds,
          })
        : [];
      const excerptContext =
        formatAskAgentTranscriptExcerptContext(transcriptExcerpts);
      const context = [memoryContext, excerptContext]
        .filter(Boolean)
        .join("\n\n");
      this.logAskAgentEvent("ask-agent.memory.context", {
        sessionId: params.activeSessionId,
        resultCount: results.length,
        excerptCount: transcriptExcerpts.length,
        chars: context.length,
      });
      return {
        context,
        disclosure: this.buildAskAgentMemoryDisclosure(
          results,
          transcriptExcerpts,
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
        label:
          result.kind === "chunk"
            ? `summary:chunk:${result.chunkId ?? result.sessionId}`
            : `summary:session:${result.sessionId}`,
        ...(result.title?.trim() ? { title: result.title.trim() } : {}),
        ...this.buildAskAgentMemoryScoreField(result.score),
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
      summaryCount: results.length,
      transcriptExcerptCount: transcriptExcerpts.length,
      sources,
    };
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
    const response = await this.buildAskAgentResponse();
    req.socket.setTimeout(0);
    res.socket?.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    this.askAgentEventClients.add(res);
    req.on("close", () => {
      this.askAgentEventClients.delete(res);
    });
    this.writeAskAgentEvent(res, "snapshot", response.snapshot);
  }

  private getAskAgentModelProvider(): string {
    return this.askAgentSessionStore.getModelProvider();
  }

  private getAskAgentModelCredential(now = Date.now()) {
    return this.modelCredentialCache.getCredential({
      providerId: this.getAskAgentModelProvider(),
      modelScope: BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE,
      now,
    });
  }

  private clearAskAgentModelCredential(): void {
    this.modelCredentialCache.clear(this.getAskAgentModelProvider());
  }

  private getAskAgentModelCredentialStatus(now = Date.now()) {
    return this.modelCredentialCache.getStatus({
      providerId: this.getAskAgentModelProvider(),
      modelScope: BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE,
      now,
    });
  }

  private handleAskAgentModelsRequest(res: http.ServerResponse): void {
    this.applyPublishedModelCatalogToAskAgent();
    const publishedCatalog = this.modelCatalogSnapshot;
    writeJson(res, 200, {
      models: this.askAgentSessionStore.getAvailableModels(),
      publishedByOwnerId: publishedCatalog?.publishedByOwnerId,
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

  private async proxyAskAgentMcpConfigRequest(
    req: http.IncomingMessage | null,
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
      const headers: Record<string, string> = {
        authorization: `Bearer ${target.authToken}`,
      };
      let body: string | undefined;
      if (req && method !== "GET") {
        const parsed = (await readJsonBody(req)) as unknown;
        body = JSON.stringify(parsed ?? {});
        headers["content-type"] = "application/json";
      }
      const response = await fetch(
        `${target.url}${targetPath}`,
        body === undefined ? { method, headers } : { method, headers, body },
      );
      const responseBody = (await response.json()) as unknown;
      writeJson(res, response.ok ? 200 : response.status, responseBody);
    } catch (err) {
      writeJson(res, 500, {
        ok: false,
        error: String(err),
      });
    }
  }

  private async handleAskAgentMcpConfigRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    await this.proxyAskAgentMcpConfigRequest(
      null,
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
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    await this.proxyAskAgentMcpConfigRequest(
      req,
      res,
      "/internal/ask-agent/mcp-config/open-raw",
      "POST",
    );
  }

  private async handleAskAgentMcpStatusRequest(
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
      const body = (await response.json()) as unknown;
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
      const body = (await response.json()) as unknown;
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
    const snapshot = await this.askAgentMemoryStore.read();
    const recentSessions = [...snapshot.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
      .map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt,
      }));
    const lastUpdatedAt =
      snapshot.sessions.length > 0 || snapshot.chunks.length > 0
        ? snapshot.updatedAt
        : null;

    return {
      sessionSummaryCount: snapshot.sessions.length,
      chunkSummaryCount: snapshot.chunks.length,
      totalSummaryCount: snapshot.sessions.length + snapshot.chunks.length,
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
      await this.askAgentMemoryStore.clear();
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

  private async handleAskAgentMemoryProposalRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayAskAgentMemoryProposalRequest | null;
      const nudgeId = typeof body?.nudgeId === "string" ? body.nudgeId : "";
      const approval = await this.askAgentMemoryProposalBridge.propose({
        tier: body?.tier ?? "memory",
        scope: body?.scope ?? "global",
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
        this.dismissAskAgentMemoryCandidateNudge(nudgeId);
      }
      const response = await this.buildAskAgentResponse();
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.dismissAskAgentMemoryCandidateNudge(body.id);
      const response = await this.buildAskAgentResponse();
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
      this.broadcastAskAgentSnapshot(response.snapshot);
      try {
        const result = await this.launchAskAgentProjectHandoff(handoff);
        this.askAgentSessionStore.completeProjectHandoff(handoff.id);
        response = await this.buildAskAgentResponse();
        this.broadcastAskAgentSnapshot(response.snapshot);
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
        this.broadcastAskAgentSnapshot(response.snapshot);
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

  private applyPublishedModelCatalogToAskAgent(): void {
    const snapshot = this.modelCatalogSnapshot;
    if (!snapshot) return;
    this.askAgentSessionStore.updateAvailableModels(
      snapshot.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        provider: model.providerId,
        contextWindow: model.contextWindow,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEfforts: model.reasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        authenticated: model.authenticated,
        condenseThreshold: model.condenseThreshold,
      })),
    );
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
      const body = (await readJsonBody(req)) as { model?: unknown } | null;
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      if (!model || !this.askAgentSessionStore.setModel(model)) {
        this.logAskAgentEvent("ask-agent.model", {
          model: model || null,
          ok: false,
          error: "invalid_model",
        });
        writeJson(res, 400, { error: "invalid_model" });
        return;
      }
      await this.askAgentPreferencesStore.update(
        this.askAgentSessionStore.getPreferencesSnapshot(),
      );
      logHelper(`ask-agent model selected model=${model}`);
      this.logAskAgentEvent("ask-agent.model", { model, ok: true });
      const now = Date.now();
      const response = this.buildAskAgentSnapshotResponse(
        now,
        await this.resolveInitialTheme(null),
      );
      this.broadcastAskAgentSnapshot(response.snapshot);
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
        !isReasoningEffort(effort) ||
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
    credential: BrowserGatewayModelCredentialRecord;
    assistantMessageId: string;
    transcriptMessages: ChatMessage[];
    memoryContext?: string;
    memoryDisclosure?: ChatMessage["memoryDisclosure"];
    theme: BrowserGatewayThemeSnapshot;
    signal: AbortSignal;
  }): Promise<AskAgentToolLoopResult> {
    const toolMessages: CoreModelMessage[] = [];
    const completeWithToolCalls =
      this.askAgentModelClient.completeWithToolCalls?.bind(
        this.askAgentModelClient,
      );

    if (!completeWithToolCalls) {
      const assistantText = await this.askAgentModelClient.complete({
        credential: params.credential,
        model: this.askAgentSessionStore.getModel(),
        reasoningEffort: this.askAgentSessionStore.getReasoningEffort(),
        messages: params.transcriptMessages,
        memoryContext: params.memoryContext,
        signal: params.signal,
        onDelta: (delta) => {
          this.askAgentSessionStore.appendAssistantDelta(
            params.assistantMessageId,
            delta,
          );
          this.broadcastAskAgentSnapshot(
            this.askAgentSessionStore.getOrCreate({
              now: Date.now(),
              theme: params.theme,
              modelCredentialStatus: this.getAskAgentModelCredentialStatus(),
            }).snapshot,
          );
        },
      });
      this.askAgentSessionStore.finishAssistantMessage(
        params.assistantMessageId,
        assistantText ||
          "I called the model, but it returned an empty response.",
        params.memoryDisclosure,
      );
      return {
        outcome: assistantText ? "model_success" : "model_empty",
        assistantText,
      };
    }

    let assistantText = "";
    const mcpBridgeTarget = await this.getAskAgentMcpBridgeTarget();
    const mcpTools = await this.getAskAgentMcpTools(
      mcpBridgeTarget,
      params.signal,
    );
    for (let iteration = 0; iteration < 4; iteration++) {
      const result = await completeWithToolCalls({
        credential: params.credential,
        model: this.askAgentSessionStore.getModel(),
        reasoningEffort: this.askAgentSessionStore.getReasoningEffort(),
        messages: params.transcriptMessages,
        memoryContext: params.memoryContext,
        toolMessages,
        tools: [...ASK_AGENT_SAFE_PROJECTLESS_TOOLS, ...mcpTools],
        signal: params.signal,
        onDelta: (delta) => {
          assistantText += delta;
          this.askAgentSessionStore.appendAssistantDelta(
            params.assistantMessageId,
            delta,
          );
          this.broadcastAskAgentSnapshot(
            this.askAgentSessionStore.getOrCreate({
              now: Date.now(),
              theme: params.theme,
              modelCredentialStatus: this.getAskAgentModelCredentialStatus(),
            }).snapshot,
          );
        },
      });
      if (!assistantText && result.text) {
        assistantText = result.text;
      }
      if (result.toolCalls.length === 0) {
        this.askAgentSessionStore.finishAssistantMessage(
          params.assistantMessageId,
          result.text ||
            "I called the model, but it returned an empty response.",
          params.memoryDisclosure,
        );
        return {
          outcome:
            result.text || assistantText ? "model_success" : "model_empty",
          assistantText: result.text || assistantText,
        };
      }

      for (const toolCall of result.toolCalls) {
        const toolStartedAt = Date.now();
        this.askAgentSessionStore.startAssistantToolCall({
          messageId: params.assistantMessageId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
        });
        this.broadcastAskAgentSnapshot(
          this.askAgentSessionStore.getOrCreate({
            now: Date.now(),
            theme: params.theme,
            modelCredentialStatus: this.getAskAgentModelCredentialStatus(),
          }).snapshot,
        );
        const executed = await this.executeAskAgentSafeProjectlessTool(
          toolCall,
          mcpBridgeTarget,
          params.signal,
        );
        if (executed.toolMessage) {
          toolMessages.push(executed.toolMessage);
        }
        this.askAgentSessionStore.completeAssistantToolCall({
          messageId: params.assistantMessageId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
          result: executed.modelResult ?? executed.content,
          durationMs: Date.now() - toolStartedAt,
        });
        this.broadcastAskAgentSnapshot(
          this.askAgentSessionStore.getOrCreate({
            now: Date.now(),
            theme: params.theme,
            modelCredentialStatus: this.getAskAgentModelCredentialStatus(),
          }).snapshot,
        );
        if (executed.stop) {
          this.askAgentSessionStore.finishAssistantMessage(
            params.assistantMessageId,
            assistantText || executed.content,
            params.memoryDisclosure,
          );
          return {
            outcome: executed.outcome ?? "model_success",
            assistantText: assistantText || executed.content,
          };
        }
      }
    }

    const fallback =
      assistantText ||
      "Ask Agent updated session state but reached its safe tool-loop limit before a final response.";
    this.askAgentSessionStore.finishAssistantMessage(
      params.assistantMessageId,
      fallback,
      params.memoryDisclosure,
    );
    return {
      outcome: assistantText ? "model_success" : "model_empty",
      assistantText,
    };
  }

  private async getAskAgentMcpBridgeTarget(): Promise<BrowserGatewayInstanceRecord | null> {
    const instances = await listHealthyBrowserGatewayInstances();
    return this.selectInstance(instances, undefined);
  }

  private async getAskAgentMcpTools(
    target: BrowserGatewayInstanceRecord | null,
    signal: AbortSignal,
  ): Promise<CoreModelToolDefinition[]> {
    if (!target) return [];
    try {
      const response = await fetch(
        `${target.url}/internal/ask-agent/mcp-tools`,
        {
          headers: { authorization: `Bearer ${target.authToken}` },
          signal,
        },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as {
        ok?: boolean;
        tools?: CoreModelToolDefinition[];
      };
      return Array.isArray(body.tools) ? body.tools : [];
    } catch (err) {
      this.logAskAgentEvent("ask-agent.tool.mcp_tools_failed", {
        ok: false,
        error: String(err),
      });
      return [];
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
      const text = result?.content.find((item) => item.type === "text")?.text;
      const content =
        text ?? JSON.stringify({ error: body.error ?? "mcp_tool_failed" });
      this.logAskAgentEvent("ask-agent.tool.mcp", {
        ok: Boolean(response.ok && body.ok),
        toolName: toolCall.name,
        targetInstanceId: target.instanceId,
      });
      return {
        content,
        stop: false,
        toolMessage: this.buildAskAgentToolResultMessage(
          toolCall,
          content,
          !(response.ok && body.ok),
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

  private async executeAskAgentSafeProjectlessTool(
    toolCall: BrowserGatewayAskAgentToolCall,
    mcpBridgeTarget: BrowserGatewayInstanceRecord | null,
    signal: AbortSignal,
  ): Promise<AskAgentToolExecutionResult> {
    const startedAt = Date.now();
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

    if (toolCall.name === "todo_write") {
      const { content, todos } = handleTodoWrite(
        toolCall.input as unknown as TodoToolInput,
      );
      this.askAgentSessionStore.setTodos(todos);
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
      if (!questionRequest) {
        const content = JSON.stringify({
          error:
            "ask_user requires at least one question with visible context in context or questions[].context",
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
      this.askAgentSessionStore.setQuestionRequest(questionRequest);
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
    const offset = Math.max(
      1,
      Math.floor(Number(toolCall.input.offset ?? 1)) || 1,
    );
    const limit = Math.max(
      1,
      Math.min(200, Math.floor(Number(toolCall.input.limit ?? 120)) || 120),
    );
    const lines = raw.split(/\r?\n/);
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
        ? this.askAgentSessionStore.completeTodos()
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
    this.askAgentSessionStore.setQuestionRequest(null);
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
    this.askAgentSessionStore.applyFinalMarker(marker);
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
  ): { id: string; context: string; questions: Question[] } | null {
    const rawQuestions = Array.isArray(toolCall.input.questions)
      ? toolCall.input.questions
      : [];
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
          ...(Array.isArray(candidate.options)
            ? { options: candidate.options.map(String) }
            : {}),
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
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    };
  }

  private async handleAskAgentRetryRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req).catch((err) => {
        if (err instanceof Error && err.message === "invalid_json") throw err;
        return null;
      })) as { sessionId?: unknown } | null;
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
      const credential = this.getAskAgentModelCredential(now);
      if (!credential) {
        this.logAskAgentEvent("ask-agent.retry", {
          sessionId: requestedSessionId,
          ok: false,
          error: "credential_missing",
        });
        writeJson(res, 409, { error: "credential_missing" });
        return;
      }
      if (this.askAgentActiveTurn) {
        this.logAskAgentEvent("ask-agent.retry", {
          sessionId: requestedSessionId,
          ok: false,
          error: "ask_agent_turn_in_progress",
        });
        writeJson(res, 409, { error: "ask_agent_turn_in_progress" });
        return;
      }

      const userMessage = this.askAgentSessionStore.prepareLatestRetryableTurn({
        sessionId: requestedSessionId,
        now,
      });
      if (!userMessage) {
        this.logAskAgentEvent("ask-agent.retry", {
          sessionId: requestedSessionId,
          ok: false,
          error: "ask_agent_retry_unavailable",
        });
        writeJson(res, 409, { error: "ask_agent_retry_unavailable" });
        return;
      }

      const sendLogFields = {
        sessionId: this.askAgentSessionStore.getActiveSessionId(),
        textChars: userMessage.content.trim().length,
        credential: "ready",
        model: this.askAgentSessionStore.getModel(),
        reasoning: this.askAgentSessionStore.getReasoningEffort(),
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
      const streamSnapshot = this.askAgentSessionStore.getOrCreate({
        now,
        theme,
        modelCredentialStatus: this.getAskAgentModelCredentialStatus(now),
      });
      this.broadcastAskAgentSnapshot(streamSnapshot.snapshot);

      let sendOutcome = "model_success";
      try {
        const controller = new AbortController();
        this.askAgentActiveTurn = {
          messageId: assistantMessage.id,
          controller,
          stopped: false,
        };
        const transcriptMessages = this.askAgentSessionStore
          .getTranscriptMessages()
          .filter((message) => message.id !== assistantMessage.id);
        const memoryContextResult = await this.buildAskAgentMemoryContext({
          query: userMessage.content,
          activeSessionId: this.askAgentSessionStore.getActiveSessionId(),
          transcriptMessages,
        });
        const turnResult = await this.runAskAgentModelTurn({
          credential,
          assistantMessageId: assistantMessage.id,
          transcriptMessages,
          memoryContext: memoryContextResult?.context,
          memoryDisclosure: memoryContextResult?.disclosure,
          theme,
          signal: controller.signal,
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
          stopped &&
          this.askAgentActiveTurn?.messageId === assistantMessage.id &&
          this.askAgentActiveTurn.stopped;
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
          this.askAgentSessionStore.finishAssistantErrorMessage({
            messageId: assistantMessage.id,
            text: errorPresentation.message,
            code: errorPresentation.code ?? sendOutcome,
            retryable: errorPresentation.retryable,
            actions: errorPresentation.actions,
          });
        }
      } finally {
        if (this.askAgentActiveTurn?.messageId === assistantMessage.id) {
          this.askAgentActiveTurn = null;
        }
      }

      await this.persistAskAgentHistory();
      if (
        sendOutcome === "model_success" ||
        sendOutcome === "model_empty" ||
        sendOutcome === "model_question" ||
        sendOutcome === "model_final"
      ) {
        this.scheduleAskAgentMemorySummary(
          this.askAgentSessionStore.getActiveSessionId(),
        );
      }
      const response = this.buildAskAgentSnapshotResponse(Date.now(), theme);
      this.logAskAgentEvent("ask-agent.retry.complete", {
        ...sendLogFields,
        ok: true,
        outcome: sendOutcome,
        messageCount:
          response.snapshot.session.foreground.projectedMessages.length,
      });
      this.broadcastAskAgentSnapshot(response.snapshot);
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
    }
  }

  private async handleAskAgentSendRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(req)) as {
        id?: unknown;
        text?: unknown;
        sessionId?: unknown;
        attachments?: unknown;
        images?: unknown;
        documents?: unknown;
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
      if (requestedSessionId) {
        if (!this.askAgentSessionStore.loadSession(requestedSessionId)) {
          this.logAskAgentEvent("ask-agent.send", {
            sessionId: requestedSessionId,
            ok: false,
            error: "ask_agent_session_not_found",
          });
          writeJson(res, 404, { error: "ask_agent_session_not_found" });
          return;
        }
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
      const activeSessionId = this.askAgentSessionStore.getActiveSessionId();
      const priorUserTexts =
        this.askAgentSessionStore.getActiveUserMessageTexts();
      const credential = this.getAskAgentModelCredential(now);
      let response: ReturnType<
        BrowserGatewayAskAgentSessionStore["sendMessage"]
      > | null = null;
      const sendLogFields = {
        sessionId: typeof body.sessionId === "string" ? body.sessionId : "none",
        textChars: body.text.trim().length,
        imageCount: images.length,
        documentCount: documents.length,
        credential: credential ? "ready" : "missing",
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
      let sendOutcome = credential ? "model_success" : "credential_missing";
      if (duplicateUserMessage) {
        response = this.buildAskAgentSnapshotResponse(now, theme);
        sendOutcome = "duplicate_ignored";
      } else if (credential && this.askAgentActiveTurn) {
        this.logAskAgentEvent("ask-agent.send", {
          ...sendLogFields,
          ok: false,
          error: "ask_agent_turn_in_progress",
        });
        writeJson(res, 409, { error: "ask_agent_turn_in_progress" });
        return;
      }
      if (!duplicateUserMessage && credential) {
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
        const streamSnapshot = this.askAgentSessionStore.getOrCreate({
          now,
          theme,
          modelCredentialStatus: this.getAskAgentModelCredentialStatus(now),
        });
        this.broadcastAskAgentSnapshot(streamSnapshot.snapshot);
        try {
          const controller = new AbortController();
          this.askAgentActiveTurn = {
            messageId: assistantMessage.id,
            controller,
            stopped: false,
          };
          const transcriptMessages = this.askAgentSessionStore
            .getTranscriptMessages()
            .filter((message) => message.id !== assistantMessage.id);
          const memoryContextResult = await this.buildAskAgentMemoryContext({
            query: body.text,
            activeSessionId: this.askAgentSessionStore.getActiveSessionId(),
            transcriptMessages,
          });
          const turnResult = await this.runAskAgentModelTurn({
            credential,
            assistantMessageId: assistantMessage.id,
            transcriptMessages,
            memoryContext: memoryContextResult?.context,
            memoryDisclosure: memoryContextResult?.disclosure,
            theme,
            signal: controller.signal,
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
            stopped &&
            this.askAgentActiveTurn?.messageId === assistantMessage.id &&
            this.askAgentActiveTurn.stopped;
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
            this.askAgentSessionStore.finishAssistantErrorMessage({
              messageId: assistantMessage.id,
              text: errorPresentation.message,
              code: errorPresentation.code ?? sendOutcome,
              retryable: errorPresentation.retryable,
              actions: errorPresentation.actions,
            });
          }
        } finally {
          if (this.askAgentActiveTurn?.messageId === assistantMessage.id) {
            this.askAgentActiveTurn = null;
          }
        }
        await this.persistAskAgentHistory();
        if (
          sendOutcome === "model_success" ||
          sendOutcome === "model_empty" ||
          sendOutcome === "model_question" ||
          sendOutcome === "model_final"
        ) {
          this.scheduleAskAgentMemorySummary(activeSessionId);
        }
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
    }
  }

  private async handleAskAgentStopRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    const activeTurn = this.askAgentActiveTurn;
    if (!activeTurn) {
      writeJson(res, 200, { ok: true, stopped: false });
      return;
    }

    activeTurn.stopped = true;
    activeTurn.controller.abort();
    this.logAskAgentEvent("ask-agent.stop", {
      messageId: activeTurn.messageId,
      ok: true,
    });
    const errorPresentation = buildAskAgentModelErrorPresentation({
      error: new Error("browser_gateway_ask_agent_model_aborted"),
      authFailed: false,
      stopped: true,
    });
    this.askAgentSessionStore.finishAssistantErrorMessage({
      messageId: activeTurn.messageId,
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
    this.broadcastAskAgentSnapshot(response.snapshot);
    writeJson(res, 200, {
      ok: true,
      stopped: true,
      snapshot: response.snapshot,
    });
  }

  private broadcastAskAgentSnapshot(
    snapshot: ReturnType<
      BrowserGatewayAskAgentSessionStore["getOrCreate"]
    >["snapshot"],
  ): void {
    for (const client of this.askAgentEventClients) {
      try {
        this.writeAskAgentEvent(client, "update", snapshot);
      } catch {
        this.askAgentEventClients.delete(client);
      }
    }
  }

  private writeAskAgentEvent(
    res: http.ServerResponse,
    event: "snapshot" | "update",
    snapshot: ReturnType<
      BrowserGatewayAskAgentSessionStore["getOrCreate"]
    >["snapshot"],
  ): void {
    if (res.destroyed || res.writableEnded) {
      this.askAgentEventClients.delete(res);
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }

  private async handleProxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const instances = await listHealthyBrowserGatewayInstances();
    const instance = this.selectInstance(instances, requestedInstanceId);

    if (!instance) {
      this.writeInstancesJson(
        res,
        "",
        instances,
        503,
        "no_instances_available",
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
  ): void {
    const body = {
      currentInstanceId,
      instances,
      error,
    };
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

      proxyReq.on("error", (error) => {
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
      const ownerRegistration = this.coreOwnerRegistry.register({
        ...body,
        ownerId: body.ownerId.trim(),
        displayName: body.displayName.trim(),
        ownerGenerationId: body.ownerGenerationId.trim(),
        instanceId: body.instanceId?.trim() || undefined,
        processId: body.processId,
        now,
      });
      this.lastLeaseActivityAtMs = now;
      logHelper(
        `core-owner register ownerId=${ownerRegistration.owner.ownerId} generation=${ownerRegistration.ownerGenerationId} kind=${ownerRegistration.owner.ownerKind}`,
      );
      writeJson(res, 200, { ok: true, ownerRegistration });
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
        !body.ownerGenerationId.trim()
      ) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const ownerRegistration = this.coreOwnerRegistry.heartbeat({
        ownerId: body.ownerId.trim(),
        ownerGenerationId: body.ownerGenerationId.trim(),
        now: Date.now(),
      });
      if (!ownerRegistration) {
        writeJson(res, 404, { error: "owner_not_registered" });
        return;
      }
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
      this.isCoreSessionScope(body.scope),
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
      const publishedAt = Date.now();
      this.modelCatalogSnapshot = {
        publishedByOwnerId: body.publishedByOwnerId.trim(),
        publishedAt,
        models: body.models.map((model) => ({
          ...model,
          id: model.id.trim(),
          displayName: model.displayName.trim(),
          providerId: model.providerId.trim(),
        })),
      };
      this.applyPublishedModelCatalogToAskAgent();
      this.logAskAgentEvent("model-catalog.published", {
        ownerId: this.modelCatalogSnapshot.publishedByOwnerId,
        modelCount: this.modelCatalogSnapshot.models.length,
      });
      const response = this.buildAskAgentSnapshotResponse(
        publishedAt,
        await this.resolveInitialTheme(null),
      );
      this.broadcastAskAgentSnapshot(response.snapshot);
      writeJson(res, 200, {
        ok: true,
        publishedAt,
        modelCount: this.modelCatalogSnapshot.models.length,
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
      typeof body.helperGenerationId === "string" &&
      body.helperGenerationId.trim() &&
      Array.isArray(body.models) &&
      body.models.length > 0 &&
      body.models.every((model) => this.isValidModelCatalogEntry(model)),
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
          model.reasoningEfforts.every(isReasoningEffort))) &&
      (model.defaultReasoningEffort === undefined ||
        isReasoningEffort(model.defaultReasoningEffort)),
    );
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
      this.broadcastAskAgentSnapshot(response.snapshot);
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
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      providerId?: unknown;
    };
    const providerId =
      typeof body.providerId === "string" ? body.providerId.trim() : undefined;
    const removed = this.modelCredentialCache.clear(providerId) !== null;
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
    this.broadcastAskAgentSnapshot(response.snapshot);
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

  private getActiveLeaseCount(nowMs = Date.now()): number {
    for (const [clientId, expiresAt] of this.activeClientLeases) {
      if (expiresAt <= nowMs) {
        this.activeClientLeases.delete(clientId);
      }
    }
    return this.activeClientLeases.size;
  }

  private async maybeShutdownForIdle(): Promise<void> {
    if (this.shuttingDown) return;
    const active = this.getActiveLeaseCount();
    const idleForMs = Date.now() - this.lastLeaseActivityAtMs;

    if (active > 0) return;
    if (idleForMs < this.options.idleShutdownMs) return;

    await this.stop("idle");
    process.exit(0);
  }

  private async writeDiscovery(): Promise<void> {
    const lanUrls = this.options.lanAccess
      ? listLanIpv4UrlsForPort(this.options.port)
      : [];
    const record: BrowserGatewayHelperDiscoveryRecord = {
      pid: process.pid,
      port: this.options.port,
      url: `http://127.0.0.1:${this.options.port}`,
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: this.startedAt.toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      helperVersion: this.options.helperVersion,
      helperGenerationId: this.helperGenerationId,
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
  ): Promise<void> {
    try {
      const assetPath = path.join(this.options.extensionRootPath, relativePath);
      const content = await fs.readFile(assetPath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
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
      initialTheme: ${JSON.stringify(initialTheme)}
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
