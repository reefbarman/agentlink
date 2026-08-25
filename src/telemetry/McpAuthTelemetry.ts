import * as os from "os";
import * as path from "path";

import { appendJsonlLinesWithLock } from "./jsonlAppend.js";
import { randomUUID } from "crypto";

export type McpAuthEventType =
  | "connect_start"
  | "connect_success"
  | "connect_auth_failure"
  | "refresh_fallback"
  | "browser_open_requested"
  | "browser_open_result"
  | "browser_open_blocked"
  | "oauth_callback"
  | "manual_reauth_entered"
  | "manual_reauth_cleared"
  | "runtime_reconnect"
  | "lease_acquired"
  | "lease_contended";

export type McpAuthTrigger =
  | "startup"
  | "config-watcher"
  | "config-mutation"
  | "plugin-refresh"
  | "ask-agent-refresh"
  | "runtime-reconnect"
  | "scheduled-retry"
  | "manual-reauth"
  | "manual-reconnect"
  | "tool-use";

export type McpAuthMode = "interactive" | "noninteractive";

export type McpAuthLeaseOutcome =
  | "acquired"
  | "contended"
  | "error"
  | "skipped";

export type McpAuthDecisionReason =
  | "allowed"
  | "blocked_cooldown"
  | "blocked_lease"
  | "blocked_manual_reauth"
  | "blocked_dialog_cap"
  | "suppressed_noninteractive"
  | "token_generation_advanced"
  | "lease_error";

/** Bounded failure taxonomy. Raw SDK errors must never be recorded. */
export type McpAuthErrorKind =
  | "unauthorized"
  | "forbidden"
  | "authorization_error"
  | "callback_timeout"
  | "callback_missing_code"
  | "refresh_failed"
  | "token_exchange_failed"
  | "redirect_mismatch"
  | "invalid_client"
  | "network"
  | "request_timeout"
  | "connection_closed"
  | "unknown";

export type McpOAuthCallbackOutcome =
  | "success"
  | "error"
  | "timeout"
  | "cancelled";

interface McpAuthEventBase {
  serverName: string;
  /** Precomputed opaque server identity. This recorder never receives or hashes URLs. */
  serverIdentityHash?: string;
  trigger?: McpAuthTrigger;
  authMode?: McpAuthMode;
  userInitiated?: boolean;
  attemptId?: string;
  rootAttemptId?: string;
  parentAttemptId?: string;
  hubScope?: string;
  hubGeneration?: number;
  retryCount?: number;
  dialogOpenCount?: number;
  hasSavedTokens?: boolean;
  hasRefreshToken?: boolean;
  tokenGenerationBefore?: number;
  tokenGenerationAfter?: number;
  leaseOutcome?: McpAuthLeaseOutcome;
  leaseWaitMs?: number;
  decisionReason?: McpAuthDecisionReason;
  browserOpened?: boolean;
}

export interface McpConnectStartEvent extends McpAuthEventBase {
  type: "connect_start";
}

export interface McpConnectSuccessEvent extends McpAuthEventBase {
  type: "connect_success";
}

export interface McpConnectAuthFailureEvent extends McpAuthEventBase {
  type: "connect_auth_failure";
  errorKind: McpAuthErrorKind;
}

export interface McpRefreshFallbackEvent extends McpAuthEventBase {
  type: "refresh_fallback";
  errorKind?: McpAuthErrorKind;
}

export interface McpBrowserOpenRequestedEvent extends McpAuthEventBase {
  type: "browser_open_requested";
}

export interface McpBrowserOpenResultEvent extends McpAuthEventBase {
  type: "browser_open_result";
  browserOpened: boolean;
}

export interface McpBrowserOpenBlockedEvent extends McpAuthEventBase {
  type: "browser_open_blocked";
  decisionReason: Exclude<McpAuthDecisionReason, "allowed">;
}

export interface McpOAuthCallbackEvent extends McpAuthEventBase {
  type: "oauth_callback";
  callbackOutcome: McpOAuthCallbackOutcome;
  errorKind?: McpAuthErrorKind;
}

export interface McpManualReauthEnteredEvent extends McpAuthEventBase {
  type: "manual_reauth_entered";
}

export interface McpManualReauthClearedEvent extends McpAuthEventBase {
  type: "manual_reauth_cleared";
}

export interface McpRuntimeReconnectEvent extends McpAuthEventBase {
  type: "runtime_reconnect";
  errorKind?: McpAuthErrorKind;
}

export interface McpLeaseAcquiredEvent extends McpAuthEventBase {
  type: "lease_acquired";
}

export interface McpLeaseContendedEvent extends McpAuthEventBase {
  type: "lease_contended";
}

export type McpAuthEvent =
  | McpConnectStartEvent
  | McpConnectSuccessEvent
  | McpConnectAuthFailureEvent
  | McpRefreshFallbackEvent
  | McpBrowserOpenRequestedEvent
  | McpBrowserOpenResultEvent
  | McpBrowserOpenBlockedEvent
  | McpOAuthCallbackEvent
  | McpManualReauthEnteredEvent
  | McpManualReauthClearedEvent
  | McpRuntimeReconnectEvent
  | McpLeaseAcquiredEvent
  | McpLeaseContendedEvent;

export interface McpAuthTelemetryRecord {
  version: 1;
  at: string;
  instanceId: string;
  pid: number;
  extensionVersion: string;
}

export interface McpAuthTelemetryOptions {
  extensionVersion?: string;
  flushIntervalMs?: number;
  telemetryPath?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  maxBufferedEvents?: number;
  log?: (message: string) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 5_000;
const MAX_SERVER_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 256;
const MAX_SCOPE_LENGTH = 128;
const MAX_EXTENSION_VERSION_LENGTH = 128;

const EVENT_TYPES = new Set<McpAuthEventType>([
  "connect_start",
  "connect_success",
  "connect_auth_failure",
  "refresh_fallback",
  "browser_open_requested",
  "browser_open_result",
  "browser_open_blocked",
  "oauth_callback",
  "manual_reauth_entered",
  "manual_reauth_cleared",
  "runtime_reconnect",
  "lease_acquired",
  "lease_contended",
]);
const TRIGGERS = new Set<McpAuthTrigger>([
  "startup",
  "config-watcher",
  "config-mutation",
  "plugin-refresh",
  "ask-agent-refresh",
  "runtime-reconnect",
  "scheduled-retry",
  "manual-reauth",
  "manual-reconnect",
  "tool-use",
]);
const AUTH_MODES = new Set<McpAuthMode>(["interactive", "noninteractive"]);
const LEASE_OUTCOMES = new Set<McpAuthLeaseOutcome>([
  "acquired",
  "contended",
  "error",
  "skipped",
]);
const DECISION_REASONS = new Set<McpAuthDecisionReason>([
  "allowed",
  "blocked_cooldown",
  "blocked_lease",
  "blocked_manual_reauth",
  "blocked_dialog_cap",
  "suppressed_noninteractive",
  "token_generation_advanced",
  "lease_error",
]);
const ERROR_KINDS = new Set<McpAuthErrorKind>([
  "unauthorized",
  "forbidden",
  "authorization_error",
  "callback_timeout",
  "callback_missing_code",
  "refresh_failed",
  "token_exchange_failed",
  "redirect_mismatch",
  "invalid_client",
  "network",
  "request_timeout",
  "connection_closed",
  "unknown",
]);
const CALLBACK_OUTCOMES = new Set<McpOAuthCallbackOutcome>([
  "success",
  "error",
  "timeout",
  "cancelled",
]);

function getDefaultTelemetryPath(): string {
  return path.join(os.homedir(), ".agentlink", "mcp-auth-telemetry.jsonl");
}

export class McpAuthTelemetry {
  private readonly telemetryPath: string;
  private readonly instanceId = randomUUID();
  private readonly extensionVersion: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly maxBufferedEvents: number;
  private readonly log?: (message: string) => void;
  private readonly flushTimer?: ReturnType<typeof setInterval>;

  private buffered: string[] = [];
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(options: McpAuthTelemetryOptions = {}) {
    this.telemetryPath = options.telemetryPath ?? getDefaultTelemetryPath();
    this.extensionVersion =
      boundedString(options.extensionVersion, MAX_EXTENSION_VERSION_LENGTH) ??
      "unknown";
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.maxBufferedEvents = Math.max(
      1,
      Math.floor(options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS),
    );
    this.log = options.log;

    const flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => this.logFlushError(err));
      }, flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  record(event: McpAuthEvent): void {
    if (this.disposed) return;
    const sanitized = sanitizeEvent(event);
    if (!sanitized) return;

    const record: McpAuthTelemetryRecord & McpAuthEvent = {
      version: 1,
      at: new Date().toISOString(),
      instanceId: this.instanceId,
      pid: process.pid,
      extensionVersion: this.extensionVersion,
      ...sanitized,
    };
    this.buffered.push(JSON.stringify(record));
    this.trimBuffer();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush().catch((err) => this.logFlushError(err));
  }

  private async flushNow(): Promise<void> {
    if (this.buffered.length === 0) return;
    const lines = this.buffered;
    this.buffered = [];
    try {
      await appendJsonlLinesWithLock(this.telemetryPath, lines, {
        lockTimeoutMs: this.lockTimeoutMs,
        staleLockMs: this.staleLockMs,
        lockTimeoutError: "mcp_auth_telemetry_lock_timeout",
      });
    } catch (err) {
      this.buffered = [...lines, ...this.buffered];
      this.trimBuffer();
      throw err;
    }
  }

  private trimBuffer(): void {
    if (this.buffered.length > this.maxBufferedEvents) {
      this.buffered.splice(0, this.buffered.length - this.maxBufferedEvents);
    }
  }

  private logFlushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.(`[mcp-auth-telemetry] flush failed: ${message}`);
  }
}

/**
 * Explicitly copies only diagnostic-safe fields. Unknown properties, raw errors,
 * URLs, callback parameters, headers, and token material are never passed through.
 */
function sanitizeEvent(event: McpAuthEvent): McpAuthEvent | null {
  if (!event || typeof event !== "object") return null;
  const input = event as unknown as Record<string, unknown>;
  const type = enumValue(input.type, EVENT_TYPES);
  const serverName = boundedString(input.serverName, MAX_SERVER_NAME_LENGTH);
  if (!type || !serverName) return null;

  const sanitized: Record<string, unknown> = { type, serverName };
  copyBoundedString(sanitized, input, "serverIdentityHash", MAX_ID_LENGTH);
  copyEnum(sanitized, input, "trigger", TRIGGERS);
  copyEnum(sanitized, input, "authMode", AUTH_MODES);
  copyBoolean(sanitized, input, "userInitiated");
  copyBoundedString(sanitized, input, "attemptId", MAX_ID_LENGTH);
  copyBoundedString(sanitized, input, "rootAttemptId", MAX_ID_LENGTH);
  copyBoundedString(sanitized, input, "parentAttemptId", MAX_ID_LENGTH);
  copyBoundedString(sanitized, input, "hubScope", MAX_SCOPE_LENGTH);
  copyNonNegativeInteger(sanitized, input, "hubGeneration");
  copyNonNegativeInteger(sanitized, input, "retryCount");
  copyNonNegativeInteger(sanitized, input, "dialogOpenCount");
  copyBoolean(sanitized, input, "hasSavedTokens");
  copyBoolean(sanitized, input, "hasRefreshToken");
  copyNonNegativeInteger(sanitized, input, "tokenGenerationBefore");
  copyNonNegativeInteger(sanitized, input, "tokenGenerationAfter");
  copyEnum(sanitized, input, "leaseOutcome", LEASE_OUTCOMES);
  copyNonNegativeInteger(sanitized, input, "leaseWaitMs");
  copyEnum(sanitized, input, "decisionReason", DECISION_REASONS);
  copyEnum(sanitized, input, "errorKind", ERROR_KINDS);
  copyBoolean(sanitized, input, "browserOpened");
  copyEnum(sanitized, input, "callbackOutcome", CALLBACK_OUTCOMES);

  if (type === "connect_auth_failure" && !sanitized.errorKind) return null;
  if (type === "browser_open_result" && !hasBoolean(sanitized.browserOpened)) {
    return null;
  }
  if (type === "browser_open_blocked") {
    if (!sanitized.decisionReason || sanitized.decisionReason === "allowed") {
      return null;
    }
  }
  if (type === "oauth_callback" && !sanitized.callbackOutcome) return null;

  return sanitized as unknown as McpAuthEvent;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T | undefined {
  return typeof value === "string" && allowed.has(value as T)
    ? (value as T)
    : undefined;
}

function copyBoundedString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  const value = boundedString(source[key], maxLength);
  if (value !== undefined) target[key] = value;
}

function copyEnum<T extends string>(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): void {
  const value = enumValue(source[key], allowed);
  if (value !== undefined) target[key] = value;
}

function copyBoolean(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === "boolean") target[key] = source[key];
}

function copyNonNegativeInteger(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    target[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
  }
}

function hasBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function createMcpAuthTelemetry(
  options: McpAuthTelemetryOptions = {},
): McpAuthTelemetry {
  return new McpAuthTelemetry(options);
}
