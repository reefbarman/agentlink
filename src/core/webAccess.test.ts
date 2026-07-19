import {
  CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN,
  DEFAULT_CORE_WEB_ACCESS_SETTINGS,
  createCoreProviderReplayEnvelope,
  normalizeCoreWebAccessSettings,
  resolveCoreWebAccessPolicy,
} from "./webAccess.js";
import { describe, expect, it } from "vitest";

describe("normalizeCoreWebAccessSettings", () => {
  it("uses default-on native settings with bounded limits", () => {
    expect(normalizeCoreWebAccessSettings()).toEqual(
      DEFAULT_CORE_WEB_ACCESS_SETTINGS,
    );
  });

  it("normalizes independent search and fetch selections", () => {
    expect(
      normalizeCoreWebAccessSettings({
        searchBackend: "mcp",
        fetchBackend: "disabled",
      }),
    ).toMatchObject({
      searchBackend: "mcp",
      fetchBackend: "disabled",
    });
  });

  it("normalizes and deduplicates domain restrictions", () => {
    expect(
      normalizeCoreWebAccessSettings({
        allowedDomains: ["Docs.Example.com/", "docs.example.com"],
      }).allowedDomains,
    ).toEqual(["docs.example.com"]);
  });

  it("rejects conflicting or unsafe domain restrictions", () => {
    expect(() =>
      normalizeCoreWebAccessSettings({
        allowedDomains: ["example.com"],
        blockedDomains: ["blocked.example.com"],
      }),
    ).toThrow("mutually exclusive");
    for (const domain of [
      "https://example.com",
      "*.example.com",
      "example.com?token=secret",
      "localhost",
      "",
    ]) {
      expect(() =>
        normalizeCoreWebAccessSettings({ allowedDomains: [domain] }),
      ).toThrow();
    }
  });

  it("rejects invalid selections and limits", () => {
    expect(() =>
      normalizeCoreWebAccessSettings({
        searchBackend: "bad" as "native",
      }),
    ).toThrow("Invalid web access searchBackend");
    expect(() =>
      normalizeCoreWebAccessSettings({ maxFetchUsesPerTurn: 0 }),
    ).toThrow("positive integer");
  });
});

describe("resolveCoreWebAccessPolicy", () => {
  it("exposes both native wrapper tools when both provider capabilities are available", () => {
    const resolved = resolveCoreWebAccessPolicy({
      providerCapabilities: {
        search: {
          supported: true,
          supportsDomainRestrictions: true,
          supportsMaxUses: true,
          supportsCitations: true,
        },
        fetch: {
          supported: true,
          supportsDomainRestrictions: true,
          supportsMaxUses: true,
          supportsContentTokenLimit: true,
          supportsCitations: true,
        },
      },
      settings: { allowedDomains: ["example.com"] },
    });

    expect(resolved).toMatchObject({
      backend: "provider",
      available: true,
      routes: {
        search: {
          backend: "provider",
          available: true,
          reason: "native_selected",
        },
        fetch: {
          backend: "provider",
          available: true,
          reason: "native_selected",
        },
      },
      enabledKinds: ["search", "fetch"],
      hostedTools: [
        {
          type: "web_search",
          allowedDomains: ["example.com"],
          maxUses: 5,
        },
        {
          type: "web_fetch",
          allowedDomains: ["example.com"],
          maxUses: 3,
          maxContentTokens: 25_000,
          citationsEnabled: true,
        },
      ],
    });
    expect(resolved.diagnostics).toMatchObject({
      maxSearchUsesEnforced: true,
      maxFetchUsesEnforced: true,
      maxFetchContentTokensEnforced: true,
    });
  });

  it("hides native search when search uses ordinary MCP tools", () => {
    const resolved = resolveCoreWebAccessPolicy({
      settings: { searchBackend: "mcp", fetchBackend: "native" },
      providerCapabilities: {
        fetch: { supported: true },
      },
    });

    expect(resolved).toMatchObject({
      backend: "mixed",
      routes: {
        search: {
          backend: "mcp",
          available: true,
          reason: "mcp_selected",
        },
        fetch: {
          backend: "provider",
          available: true,
          reason: "native_selected",
        },
      },
      enabledKinds: ["fetch"],
    });
    expect(resolved.hostedTools).toEqual([
      expect.objectContaining({ type: "web_fetch" }),
    ]);
  });

  it("hides native fetch when fetch uses ordinary MCP tools", () => {
    const resolved = resolveCoreWebAccessPolicy({
      settings: { searchBackend: "native", fetchBackend: "mcp" },
      providerCapabilities: {
        search: { supported: true },
      },
    });

    expect(resolved).toMatchObject({
      backend: "mixed",
      routes: {
        search: { backend: "provider", available: true },
        fetch: { backend: "mcp", available: true },
      },
      enabledKinds: ["search"],
    });
    expect(resolved.hostedTools).toEqual([{ type: "web_search" }]);
  });

  it("selects MCP without requiring or adapting a specific MCP tool", () => {
    const resolved = resolveCoreWebAccessPolicy({
      settings: { searchBackend: "mcp", fetchBackend: "mcp" },
    });

    expect(resolved).toMatchObject({
      backend: "mcp",
      available: true,
      routes: {
        search: { backend: "mcp", available: true },
        fetch: { backend: "mcp", available: true },
      },
      enabledKinds: [],
      hostedTools: [],
    });
  });

  it("fails closed only for a selected native operation the provider cannot perform", () => {
    const resolved = resolveCoreWebAccessPolicy({
      settings: { searchBackend: "native", fetchBackend: "mcp" },
      providerCapabilities: {
        search: { supported: false },
      },
    });

    expect(resolved).toMatchObject({
      backend: "mcp",
      available: true,
      routes: {
        search: {
          backend: "disabled",
          available: false,
          reason: "native_unsupported",
        },
        fetch: { backend: "mcp", available: true },
      },
      enabledKinds: [],
    });
  });

  it("uses hosted search page access to implement native fetch for Codex", () => {
    const resolved = resolveCoreWebAccessPolicy({
      settings: { searchBackend: "mcp", fetchBackend: "native" },
      providerCapabilities: {
        search: {
          supported: true,
          supportsPageAccess: true,
          supportsMaxUses: true,
        },
      },
    });

    expect(resolved.routes.fetch).toMatchObject({
      backend: "provider",
      available: true,
      hostedTool: { type: "web_search", maxUses: 3 },
    });
    expect(resolved.enabledKinds).toEqual(["fetch"]);
    expect(resolved.diagnostics).toMatchObject({
      providerFetchSupported: false,
      maxFetchUsesEnforced: true,
      maxFetchContentTokensEnforced: false,
    });
  });

  it("does not claim a delegated fetch limit when hosted search cannot enforce it", () => {
    const resolved = resolveCoreWebAccessPolicy({
      settings: { searchBackend: "disabled", fetchBackend: "native" },
      providerCapabilities: {
        search: { supported: true, supportsPageAccess: true },
      },
    });

    expect(resolved.routes.fetch.available).toBe(true);
    expect(resolved.diagnostics.maxFetchUsesEnforced).toBe(false);
  });

  it("fails closed when a selected native route cannot enforce domain restrictions", () => {
    const resolved = resolveCoreWebAccessPolicy({
      settings: {
        searchBackend: "native",
        fetchBackend: "mcp",
        allowedDomains: ["example.com"],
      },
      providerCapabilities: {
        search: {
          supported: true,
          supportsDomainRestrictions: false,
        },
      },
    });

    expect(resolved.routes.search).toMatchObject({
      backend: "disabled",
      available: false,
      reason: "native_restrictions_unsupported",
    });
    expect(resolved.routes.fetch).toMatchObject({
      backend: "mcp",
      available: true,
    });
  });

  it("disables both native wrapper tools explicitly", () => {
    expect(
      resolveCoreWebAccessPolicy({
        settings: { searchBackend: "disabled", fetchBackend: "disabled" },
        providerCapabilities: {
          search: { supported: true },
          fetch: { supported: true },
        },
      }),
    ).toMatchObject({
      backend: "disabled",
      available: false,
      enabledKinds: [],
      hostedTools: [],
      routes: {
        search: { reason: "disabled" },
        fetch: { reason: "disabled" },
      },
    });
  });
});

describe("createCoreProviderReplayEnvelope", () => {
  it("returns exact JSON-safe replay under the cap", () => {
    expect(
      createCoreProviderReplayEnvelope({
        providerId: "anthropic",
        codecVersion: 1,
        payload: { encrypted_content: "ciphertext" },
        maxBytes: CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN,
      }),
    ).toEqual({
      providerId: "anthropic",
      codecVersion: 1,
      payload: { encrypted_content: "ciphertext" },
      serializedBytes: 34,
    });
  });

  it("marks oversized replay degraded without truncating opaque content", () => {
    const envelope = createCoreProviderReplayEnvelope({
      providerId: "anthropic",
      codecVersion: 1,
      payload: { content: "x".repeat(100) },
      maxBytes: 20,
    });
    expect(envelope).toMatchObject({
      providerId: "anthropic",
      codecVersion: 1,
      payload: null,
      degraded: true,
      degradedReason: "size_limit",
    });
    expect(envelope.serializedBytes).toBeGreaterThan(20);
  });
});
