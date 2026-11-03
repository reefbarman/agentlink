import type {
  PriorDiscovery,
  VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/client";

import type { McpServerConfig } from "./mcpConfig.js";
import { createHash } from "node:crypto";

/** Per-server `protocol` setting in mcp.json. */
export type McpProtocolSetting = "auto" | "legacy" | "2026-07-28";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

type McpDiscoverResult = Extract<
  PriorDiscovery,
  { kind: "modern" }
>["discover"];

/**
 * A remembered negotiation outcome, so the `server/discover` probe (and the
 * extra process spawn it costs on stdio) runs once per server rather than on
 * every connect.
 */
export type McpProtocolVerdict =
  | {
      readonly kind: "modern";
      readonly discover: McpDiscoverResult;
      readonly checkedAt: number;
    }
  | { readonly kind: "legacy"; readonly checkedAt: number };

/** Host-provided persistence for verdicts. Values are untrusted on read. */
export interface McpProtocolVerdictStore {
  get(key: string): unknown;
  set(key: string, verdict: McpProtocolVerdict): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** Re-probe after a week so servers that upgrade are noticed. */
export const MCP_PROTOCOL_VERDICT_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * A stdio server that ignores the probe is a legacy server. Without a bound
 * the first connect would wait out the full 60s request timeout.
 */
export const MCP_STDIO_PROBE_TIMEOUT_MS = 10_000;

export interface McpProtocolPlan {
  readonly setting: McpProtocolSetting;
  readonly negotiation: VersionNegotiationOptions;
  /** Present when a remembered verdict skips the probe. */
  readonly prior?: PriorDiscovery;
  /** Verdict store key; present only for `auto`, the one cached setting. */
  readonly verdictKey?: string;
}

export function normalizeMcpProtocolSetting(
  value: unknown,
): McpProtocolSetting {
  return value === "legacy" || value === MCP_MODERN_PROTOCOL_VERSION
    ? value
    : "auto";
}

/**
 * Identity of the server the verdict describes. Any change to the URL,
 * command, arguments, working directory, environment or headers can select a
 * different server, so it probes again. The key is a one-way hash; secret
 * values in the environment or headers are never stored.
 */
export function mcpProtocolVerdictKey(cfg: Readonly<McpServerConfig>): string {
  const type = cfg.type ?? "stdio";
  const sorted = (record: Readonly<Record<string, string>> | undefined) =>
    Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const identity =
    type === "stdio"
      ? [cfg.command ?? "", cfg.args ?? [], cfg.cwd ?? "", sorted(cfg.env)]
      : [cfg.url ?? "", sorted(cfg.headers)];
  return createHash("sha256")
    .update(JSON.stringify([cfg.name, type, ...identity]))
    .digest("hex")
    .slice(0, 32);
}

export function parseMcpProtocolVerdict(
  value: unknown,
): McpProtocolVerdict | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.checkedAt !== "number" ||
    !Number.isFinite(record.checkedAt)
  ) {
    return undefined;
  }
  if (record.kind === "legacy") {
    return { kind: "legacy", checkedAt: record.checkedAt };
  }
  if (record.kind !== "modern") return undefined;
  const discover = record.discover as Record<string, unknown> | undefined;
  if (
    typeof discover !== "object" ||
    discover === null ||
    !Array.isArray(discover.supportedVersions) ||
    !discover.supportedVersions.every((v) => typeof v === "string") ||
    typeof discover.capabilities !== "object" ||
    discover.capabilities === null
  ) {
    return undefined;
  }
  return {
    kind: "modern",
    discover: discover as McpDiscoverResult,
    checkedAt: record.checkedAt,
  };
}

/**
 * Decide how to negotiate with one server. `auto` probes with
 * `server/discover` and falls back to `initialize`; a fresh remembered
 * verdict skips the probe. The explicit settings never consult the cache.
 */
export function resolveMcpProtocolPlan(
  cfg: Readonly<McpServerConfig>,
  storedVerdict: unknown,
  options: {
    readonly now: number;
    readonly interactiveAuth: boolean;
    /**
     * The stdio command is a sign-in proxy (for example `mcp-remote`). The
     * probe's sibling process would start a second sign-in or token refresh,
     * so `auto` uses the 2025-era handshake without probing.
     */
    readonly authProxy?: boolean;
  },
): McpProtocolPlan {
  const setting = normalizeMcpProtocolSetting(cfg.protocol);
  if (setting === "legacy" || (setting === "auto" && options.authProxy)) {
    return { setting, negotiation: { mode: "legacy" } };
  }
  if (setting === MCP_MODERN_PROTOCOL_VERSION) {
    return {
      setting,
      negotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } },
    };
  }

  const isStdio = (cfg.type ?? "stdio") === "stdio";
  const negotiation: VersionNegotiationOptions = {
    mode: "auto",
    ...(isStdio ? { probe: { timeoutMs: MCP_STDIO_PROBE_TIMEOUT_MS } } : {}),
  };
  const verdictKey = mcpProtocolVerdictKey(cfg);
  const verdict = parseMcpProtocolVerdict(storedVerdict);
  if (!verdict || options.now - verdict.checkedAt > MCP_PROTOCOL_VERDICT_TTL_MS)
    return { setting, negotiation, verdictKey };
  // A remembered modern verdict connects with zero round trips, which moves
  // any browser sign-in from the connect handshake (long interactive timeout)
  // to the first catalog request (standard timeout). Probe instead.
  if (verdict.kind === "modern" && options.interactiveAuth)
    return { setting, negotiation, verdictKey };
  return {
    setting,
    negotiation,
    verdictKey,
    prior:
      verdict.kind === "modern"
        ? { kind: "modern", discover: verdict.discover }
        : { kind: "legacy" },
  };
}

/**
 * A server that answered the `server/discover` probe with an HTTP 5xx or an
 * unreadable reply. Such a 2025-era server may still accept `initialize`, so
 * the next attempt should use it instead of failing the same way. Network
 * failures are excluded: they say nothing about the protocol version.
 */
export function isMcpProbeRejection(error: unknown): boolean {
  if (!SdkError.isInstance(error)) return false;
  if (error.code !== SdkErrorCode.EraNegotiationFailed) return false;
  return (
    SdkHttpError.isInstance(error) || error.message.includes("unusable reply")
  );
}

/** Process-wide fallback for hosts without durable storage. */
export function createInMemoryMcpProtocolVerdictStore(): McpProtocolVerdictStore {
  const verdicts = new Map<string, McpProtocolVerdict>();
  return {
    get: (key) => verdicts.get(key),
    set: (key, verdict) => {
      verdicts.set(key, verdict);
    },
    delete: (key) => {
      verdicts.delete(key);
    },
  };
}
