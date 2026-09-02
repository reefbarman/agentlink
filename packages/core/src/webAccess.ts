export type {
  CoreJsonValue,
  CoreProviderReplayEnvelope,
} from "@agentlink/protocol/provider-replay";
export type {
  CoreWebAccessBackend,
  CoreWebActivity,
  CoreWebActivityStatus,
  CoreWebCitation,
  CoreWebToolKind,
} from "@agentlink/protocol/web-activity";
export type {
  CoreHostedToolDefinition,
  CoreHostedWebCapabilities,
  CoreHostedWebFetchDefinition,
  CoreHostedWebSearchDefinition,
  CoreHostedWebToolCapability,
  CoreResolveWebAccessPolicyInput,
  CoreResolvedWebAccessPolicy,
  CoreResolvedWebAccessRoute,
  CoreWebAccessResolutionReason,
  CoreWebAccessSelection,
  CoreWebAccessSettings,
  CoreWebAccessSettingsInput,
  CoreWebSearchMode,
} from "@agentlink/protocol/web-access-policy";

import type {
  CoreHostedToolDefinition,
  CoreHostedWebCapabilities,
  CoreResolveWebAccessPolicyInput,
  CoreResolvedWebAccessPolicy,
  CoreResolvedWebAccessRoute,
  CoreWebAccessResolutionReason,
  CoreWebAccessSelection,
  CoreWebAccessSettings,
  CoreWebAccessSettingsInput,
  CoreWebSearchMode,
} from "@agentlink/protocol/web-access-policy";
import type {
  CoreJsonValue,
  CoreProviderReplayEnvelope,
} from "@agentlink/protocol/provider-replay";
import type {
  CoreWebAccessBackend,
  CoreWebToolKind,
} from "@agentlink/protocol/web-activity";

export const CORE_WEB_ACCESS_DEFAULT_MAX_SEARCH_USES_PER_TURN = 5;
export const CORE_WEB_ACCESS_DEFAULT_MAX_FETCH_USES_PER_TURN = 3;
export const CORE_WEB_ACCESS_DEFAULT_MAX_FETCH_CONTENT_TOKENS = 25_000;
export const CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN = 5_242_880;

export const DEFAULT_CORE_WEB_ACCESS_SETTINGS: Readonly<CoreWebAccessSettings> =
  Object.freeze({
    searchBackend: "native",
    fetchBackend: "native",
    nativeSearchMode: "cached",
    allowedDomains: [],
    blockedDomains: [],
    maxSearchUsesPerTurn: CORE_WEB_ACCESS_DEFAULT_MAX_SEARCH_USES_PER_TURN,
    maxFetchUsesPerTurn: CORE_WEB_ACCESS_DEFAULT_MAX_FETCH_USES_PER_TURN,
    maxFetchContentTokens: CORE_WEB_ACCESS_DEFAULT_MAX_FETCH_CONTENT_TOKENS,
    maxReplayBytesPerTurn: CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN,
  });

export function normalizeCoreWebAccessSettings(
  value: CoreWebAccessSettingsInput = {},
): CoreWebAccessSettings {
  const searchBackend = resolveSelection(
    value.searchBackend,
    DEFAULT_CORE_WEB_ACCESS_SETTINGS.searchBackend,
    "searchBackend",
  );
  const fetchBackend = resolveSelection(
    value.fetchBackend,
    DEFAULT_CORE_WEB_ACCESS_SETTINGS.fetchBackend,
    "fetchBackend",
  );
  const nativeSearchMode = resolveSearchMode(value.nativeSearchMode);

  const allowedDomains = normalizeDomainList(value.allowedDomains ?? []);
  const blockedDomains = normalizeDomainList(value.blockedDomains ?? []);
  if (allowedDomains.length > 0 && blockedDomains.length > 0) {
    throw new Error(
      "webAccess.allowedDomains and webAccess.blockedDomains are mutually exclusive",
    );
  }

  return {
    searchBackend,
    fetchBackend,
    nativeSearchMode,
    allowedDomains,
    blockedDomains,
    maxSearchUsesPerTurn: normalizePositiveInteger(
      value.maxSearchUsesPerTurn,
      DEFAULT_CORE_WEB_ACCESS_SETTINGS.maxSearchUsesPerTurn,
      "maxSearchUsesPerTurn",
    ),
    maxFetchUsesPerTurn: normalizePositiveInteger(
      value.maxFetchUsesPerTurn,
      DEFAULT_CORE_WEB_ACCESS_SETTINGS.maxFetchUsesPerTurn,
      "maxFetchUsesPerTurn",
    ),
    maxFetchContentTokens: normalizePositiveInteger(
      value.maxFetchContentTokens,
      DEFAULT_CORE_WEB_ACCESS_SETTINGS.maxFetchContentTokens,
      "maxFetchContentTokens",
    ),
    maxReplayBytesPerTurn: normalizePositiveInteger(
      value.maxReplayBytesPerTurn,
      DEFAULT_CORE_WEB_ACCESS_SETTINGS.maxReplayBytesPerTurn,
      "maxReplayBytesPerTurn",
    ),
  };
}

function resolveSearchMode(value: unknown): CoreWebSearchMode {
  if (value === undefined)
    return DEFAULT_CORE_WEB_ACCESS_SETTINGS.nativeSearchMode;
  if (value === "cached" || value === "indexed" || value === "live") {
    return value;
  }
  throw new Error(`Invalid web access nativeSearchMode: ${String(value)}`);
}

export function resolveCoreWebAccessPolicy(
  input: CoreResolveWebAccessPolicyInput,
): CoreResolvedWebAccessPolicy {
  const settings = normalizeCoreWebAccessSettings(input.settings);
  const providerCapabilities = input.providerCapabilities ?? {};
  const restrictionsRequested =
    settings.allowedDomains.length > 0 || settings.blockedDomains.length > 0;
  const search = resolveRoute({
    kind: "search",
    selection: settings.searchBackend,
    settings,
    providerCapabilities,
    restrictionsRequested,
  });
  const fetch = resolveRoute({
    kind: "fetch",
    selection: settings.fetchBackend,
    settings,
    providerCapabilities,
    restrictionsRequested,
  });
  const enabledKinds = [search, fetch]
    .filter((route) => route.backend === "provider" && route.available)
    .map((route) => route.kind);
  const activeBackends = new Set(
    [search, fetch]
      .filter((route) => route.available)
      .map((route) => route.backend),
  );
  const backend: CoreWebAccessBackend =
    activeBackends.size === 0
      ? "disabled"
      : activeBackends.size === 1
        ? ([...activeBackends][0] ?? "disabled")
        : "mixed";

  return {
    backend,
    available: search.available || fetch.available,
    routes: { search, fetch },
    settings,
    hostedTools: [search.hostedTool, fetch.hostedTool].filter(
      (tool): tool is CoreHostedToolDefinition => Boolean(tool),
    ),
    enabledKinds,
    diagnostics: makeDiagnostics(
      settings,
      providerCapabilities,
      restrictionsRequested,
    ),
  };
}

export function createCoreProviderReplayEnvelope(params: {
  providerId: string;
  codecVersion: number;
  payload: CoreJsonValue;
  maxBytes: number;
}): CoreProviderReplayEnvelope {
  const providerId = params.providerId.trim();
  if (!providerId) throw new Error("providerId is required");
  if (!Number.isInteger(params.codecVersion) || params.codecVersion < 1) {
    throw new Error("codecVersion must be a positive integer");
  }
  const serialized = JSON.stringify(params.payload);
  const serializedBytes = new TextEncoder().encode(serialized).byteLength;
  if (serializedBytes > params.maxBytes) {
    return {
      providerId,
      codecVersion: params.codecVersion,
      payload: null,
      serializedBytes,
      degraded: true,
      degradedReason: "size_limit",
    };
  }
  return {
    providerId,
    codecVersion: params.codecVersion,
    payload: params.payload,
    serializedBytes,
  };
}

function resolveRoute(params: {
  kind: CoreWebToolKind;
  selection: CoreWebAccessSelection;
  settings: CoreWebAccessSettings;
  providerCapabilities: CoreHostedWebCapabilities;
  restrictionsRequested: boolean;
}): CoreResolvedWebAccessRoute {
  const provider = evaluateProviderRoute(
    params.kind,
    params.settings,
    params.providerCapabilities,
    params.restrictionsRequested,
  );

  const disabled = (
    reason: CoreWebAccessResolutionReason,
  ): CoreResolvedWebAccessRoute => ({
    kind: params.kind,
    backend: "disabled",
    available: false,
    reason,
  });
  const providerRoute = (): CoreResolvedWebAccessRoute => ({
    kind: params.kind,
    backend: "provider",
    available: true,
    reason: "native_selected",
    hostedTool: buildHostedTool(
      params.kind,
      params.settings,
      params.providerCapabilities,
    ),
  });
  if (params.selection === "disabled") return disabled("disabled");
  if (params.selection === "mcp") {
    return {
      kind: params.kind,
      backend: "mcp",
      available: true,
      reason: "mcp_selected",
    };
  }
  return provider.available ? providerRoute() : disabled(provider.reason);
}

function evaluateProviderRoute(
  kind: CoreWebToolKind,
  settings: CoreWebAccessSettings,
  capabilities: CoreHostedWebCapabilities,
  restrictionsRequested: boolean,
): {
  available: boolean;
  reason: "native_unsupported" | "native_restrictions_unsupported";
} {
  const capability =
    kind === "fetch" && capabilities.fetch?.supported !== true
      ? capabilities.search?.supportsPageAccess === true
        ? capabilities.search
        : undefined
      : capabilities[kind];
  if (capability?.supported !== true) {
    return { available: false, reason: "native_unsupported" };
  }
  if (restrictionsRequested && capability.supportsDomainRestrictions !== true) {
    return {
      available: false,
      reason: "native_restrictions_unsupported",
    };
  }
  return { available: true, reason: "native_unsupported" };
}

function buildHostedTool(
  kind: CoreWebToolKind,
  settings: CoreWebAccessSettings,
  capabilities: CoreHostedWebCapabilities,
): CoreHostedToolDefinition {
  const domainFields = {
    ...(settings.allowedDomains.length > 0
      ? { allowedDomains: settings.allowedDomains }
      : {}),
    ...(settings.blockedDomains.length > 0
      ? { blockedDomains: settings.blockedDomains }
      : {}),
  };
  if (kind === "search") {
    return {
      type: "web_search",
      ...domainFields,
      ...(capabilities.search?.supportsMaxUses
        ? { maxUses: settings.maxSearchUsesPerTurn }
        : {}),
    };
  }
  if (capabilities.fetch?.supported) {
    return {
      type: "web_fetch",
      ...domainFields,
      ...(capabilities.fetch.supportsMaxUses
        ? { maxUses: settings.maxFetchUsesPerTurn }
        : {}),
      ...(capabilities.fetch.supportsContentTokenLimit
        ? { maxContentTokens: settings.maxFetchContentTokens }
        : {}),
      citationsEnabled: true,
    };
  }
  return {
    type: "web_search",
    ...domainFields,
    ...(capabilities.search?.supportsMaxUses
      ? { maxUses: settings.maxFetchUsesPerTurn }
      : {}),
  };
}

function makeDiagnostics(
  settings: CoreWebAccessSettings,
  capabilities: CoreHostedWebCapabilities,
  restrictionsRequested: boolean,
): CoreResolvedWebAccessPolicy["diagnostics"] {
  return {
    providerSearchSupported: capabilities.search?.supported === true,
    providerFetchSupported: capabilities.fetch?.supported === true,
    domainRestrictionsRequested: restrictionsRequested,
    maxSearchUsesEnforced:
      settings.searchBackend !== "disabled" &&
      capabilities.search?.supportsMaxUses === true,
    maxFetchUsesEnforced:
      settings.fetchBackend !== "disabled" &&
      (capabilities.fetch?.supportsMaxUses === true ||
        (capabilities.search?.supportsPageAccess === true &&
          capabilities.search.supportsMaxUses === true)),
    maxFetchContentTokensEnforced:
      settings.fetchBackend !== "disabled" &&
      capabilities.fetch?.supportsContentTokenLimit === true,
  };
}

function resolveSelection(
  value: unknown,
  fallback: CoreWebAccessSelection,
  field: string,
): CoreWebAccessSelection {
  if (value === "native" || value === "mcp" || value === "disabled") {
    return value;
  }
  if (value !== undefined) {
    throw new Error(`Invalid web access ${field}: ${String(value)}`);
  }
  return fallback;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`webAccess.${field} must be a positive integer`);
  }
  return resolved;
}

function normalizeDomainList(values: string[]): string[] {
  const normalized = values.map(normalizeDomain);
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
}

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\/$/, "");
  if (!normalized) throw new Error("Web domain entries must not be empty");
  if (
    normalized.includes("://") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.includes("@") ||
    normalized.includes("*") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(
      normalized,
    )
  ) {
    throw new Error(`Invalid web domain restriction: ${value}`);
  }
  return normalized;
}
