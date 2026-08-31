import type { CoreWebAccessBackend, CoreWebToolKind } from "./webActivity.js";

export type CoreWebAccessSelection = "native" | "mcp" | "disabled";
export type CoreWebSearchMode = "cached" | "indexed" | "live";

export interface CoreWebAccessSettings {
  searchBackend: CoreWebAccessSelection;
  fetchBackend: CoreWebAccessSelection;
  nativeSearchMode: CoreWebSearchMode;
  allowedDomains: string[];
  blockedDomains: string[];
  maxSearchUsesPerTurn: number;
  maxFetchUsesPerTurn: number;
  maxFetchContentTokens: number;
  maxReplayBytesPerTurn: number;
}

export type CoreWebAccessSettingsInput = Partial<CoreWebAccessSettings>;

export interface CoreHostedWebToolCapability {
  supported: boolean;
  supportsDomainRestrictions?: boolean;
  supportsMaxUses?: boolean;
  supportsContentTokenLimit?: boolean;
  supportsCitations?: boolean;
  /** The hosted search tool can open a caller-supplied URL for delegated fetch. */
  supportsPageAccess?: boolean;
}

export interface CoreHostedWebCapabilities {
  search?: CoreHostedWebToolCapability;
  fetch?: CoreHostedWebToolCapability;
}

export interface CoreHostedWebSearchDefinition {
  type: "web_search";
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
}

export interface CoreHostedWebFetchDefinition {
  type: "web_fetch";
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
  maxContentTokens?: number;
  citationsEnabled: boolean;
}

export type CoreHostedToolDefinition =
  | CoreHostedWebSearchDefinition
  | CoreHostedWebFetchDefinition;

export type CoreWebAccessResolutionReason =
  | "disabled"
  | "native_selected"
  | "native_unsupported"
  | "native_restrictions_unsupported"
  | "mcp_selected";

export interface CoreResolvedWebAccessRoute {
  kind: CoreWebToolKind;
  backend: Exclude<CoreWebAccessBackend, "mixed">;
  available: boolean;
  reason: CoreWebAccessResolutionReason;
  hostedTool?: CoreHostedToolDefinition;
}

export interface CoreResolvedWebAccessPolicy {
  backend: CoreWebAccessBackend;
  available: boolean;
  routes: {
    search: CoreResolvedWebAccessRoute;
    fetch: CoreResolvedWebAccessRoute;
  };
  settings: CoreWebAccessSettings;
  /** Provider definitions used only by delegated wrapper execution. */
  hostedTools: CoreHostedToolDefinition[];
  enabledKinds: CoreWebToolKind[];
  diagnostics: {
    providerSearchSupported: boolean;
    providerFetchSupported: boolean;
    domainRestrictionsRequested: boolean;
    maxSearchUsesEnforced: boolean;
    maxFetchUsesEnforced: boolean;
    maxFetchContentTokensEnforced: boolean;
  };
}

export interface CoreResolveWebAccessPolicyInput {
  settings?: CoreWebAccessSettingsInput;
  providerCapabilities?: CoreHostedWebCapabilities;
}
