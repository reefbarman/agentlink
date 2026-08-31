import type {
  CoreHostedToolDefinition,
  CoreHostedWebCapabilities,
  CoreHostedWebToolCapability,
  CoreResolveWebAccessPolicyInput,
  CoreResolvedWebAccessPolicy,
  CoreResolvedWebAccessRoute,
  CoreWebAccessResolutionReason,
  CoreWebAccessSelection,
  CoreWebAccessSettings,
  CoreWebAccessSettingsInput,
  CoreWebSearchMode,
} from "./webAccessPolicy.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins web access policy contracts", () => {
  expectTypeOf<CoreWebAccessSelection>().toEqualTypeOf<
    "native" | "mcp" | "disabled"
  >();
  expectTypeOf<CoreWebSearchMode>().toEqualTypeOf<
    "cached" | "indexed" | "live"
  >();
  expectTypeOf<CoreWebAccessResolutionReason>().toEqualTypeOf<
    | "disabled"
    | "native_selected"
    | "native_unsupported"
    | "native_restrictions_unsupported"
    | "mcp_selected"
  >();
  expectTypeOf<CoreWebAccessSettings>().toEqualTypeOf<{
    searchBackend: CoreWebAccessSelection;
    fetchBackend: CoreWebAccessSelection;
    nativeSearchMode: CoreWebSearchMode;
    allowedDomains: string[];
    blockedDomains: string[];
    maxSearchUsesPerTurn: number;
    maxFetchUsesPerTurn: number;
    maxFetchContentTokens: number;
    maxReplayBytesPerTurn: number;
  }>();
  expectTypeOf<CoreWebAccessSettingsInput>().toEqualTypeOf<
    Partial<CoreWebAccessSettings>
  >();
  expectTypeOf<CoreHostedWebToolCapability>().toEqualTypeOf<{
    supported: boolean;
    supportsDomainRestrictions?: boolean;
    supportsMaxUses?: boolean;
    supportsContentTokenLimit?: boolean;
    supportsCitations?: boolean;
    supportsPageAccess?: boolean;
  }>();
  expectTypeOf<CoreHostedWebCapabilities>().toEqualTypeOf<{
    search?: CoreHostedWebToolCapability;
    fetch?: CoreHostedWebToolCapability;
  }>();
  expectTypeOf<CoreHostedToolDefinition>().toEqualTypeOf<
    | {
        type: "web_search";
        allowedDomains?: string[];
        blockedDomains?: string[];
        maxUses?: number;
      }
    | {
        type: "web_fetch";
        allowedDomains?: string[];
        blockedDomains?: string[];
        maxUses?: number;
        maxContentTokens?: number;
        citationsEnabled: boolean;
      }
  >();
  expectTypeOf<CoreResolvedWebAccessRoute>().toEqualTypeOf<{
    kind: import("./webActivity.js").CoreWebToolKind;
    backend: Exclude<import("./webActivity.js").CoreWebAccessBackend, "mixed">;
    available: boolean;
    reason: CoreWebAccessResolutionReason;
    hostedTool?: CoreHostedToolDefinition;
  }>();
  expectTypeOf<CoreResolvedWebAccessPolicy>().toEqualTypeOf<{
    backend: import("./webActivity.js").CoreWebAccessBackend;
    available: boolean;
    routes: {
      search: CoreResolvedWebAccessRoute;
      fetch: CoreResolvedWebAccessRoute;
    };
    settings: CoreWebAccessSettings;
    hostedTools: CoreHostedToolDefinition[];
    enabledKinds: import("./webActivity.js").CoreWebToolKind[];
    diagnostics: {
      providerSearchSupported: boolean;
      providerFetchSupported: boolean;
      domainRestrictionsRequested: boolean;
      maxSearchUsesEnforced: boolean;
      maxFetchUsesEnforced: boolean;
      maxFetchContentTokensEnforced: boolean;
    };
  }>();
  expectTypeOf<CoreResolveWebAccessPolicyInput>().toEqualTypeOf<{
    settings?: CoreWebAccessSettingsInput;
    providerCapabilities?: CoreHostedWebCapabilities;
  }>();
});

it("keeps web access policy snapshots serializable across surfaces", () => {
  const value: CoreResolvedWebAccessPolicy = {
    backend: "mixed",
    available: true,
    routes: {
      search: {
        kind: "search",
        backend: "provider",
        available: true,
        reason: "native_selected",
        hostedTool: { type: "web_search", maxUses: 5 },
      },
      fetch: {
        kind: "fetch",
        backend: "mcp",
        available: true,
        reason: "mcp_selected",
      },
    },
    settings: {
      searchBackend: "native",
      fetchBackend: "mcp",
      nativeSearchMode: "live",
      allowedDomains: ["example.com"],
      blockedDomains: [],
      maxSearchUsesPerTurn: 5,
      maxFetchUsesPerTurn: 3,
      maxFetchContentTokens: 25_000,
      maxReplayBytesPerTurn: 5_242_880,
    },
    hostedTools: [{ type: "web_search", maxUses: 5 }],
    enabledKinds: ["search", "fetch"],
    diagnostics: {
      providerSearchSupported: true,
      providerFetchSupported: false,
      domainRestrictionsRequested: true,
      maxSearchUsesEnforced: true,
      maxFetchUsesEnforced: true,
      maxFetchContentTokensEnforced: true,
    },
  };

  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});
