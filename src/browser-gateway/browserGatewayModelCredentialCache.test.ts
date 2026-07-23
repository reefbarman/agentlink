import { describe, expect, it } from "vitest";

import { BrowserGatewayModelCredentialCache } from "./browserGatewayModelCredentialCache.js";

const owner = {
  grantedByOwnerId: "vscode-owner",
  grantedByOwnerGenerationId: "vscode-generation-1",
};

function grant(
  cache: BrowserGatewayModelCredentialCache,
  overrides: Partial<Parameters<typeof cache.grant>[0]> = {},
) {
  return cache.grant({
    providerId: "openai-codex",
    method: "oauth",
    bearerToken: "token",
    ...owner,
    modelScopes: ["chat"],
    helperGenerationId: "helper-generation-1",
    now: 1_000,
    ...overrides,
  });
}

describe("BrowserGatewayModelCredentialCache", () => {
  it("normalizes VS Code Codex provider IDs within one owner generation", () => {
    const cache = new BrowserGatewayModelCredentialCache();

    const credential = grant(cache);

    expect(credential.providerId).toBe("openai-codex");
    expect(
      cache.getCredential({
        ...owner,
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      })?.bearerToken,
    ).toBe("token");
    expect(
      cache.getStatus({
        ...owner,
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      }),
    ).toMatchObject({ state: "ready", providerId: "openai-codex" });
  });

  it("clears only the matching owner, generation, and provider", () => {
    const cache = new BrowserGatewayModelCredentialCache();
    grant(cache, { providerId: "codex", method: "apiKey" });

    expect(
      cache.clear({ ...owner, providerId: "openai-codex" })?.providerId,
    ).toBe("openai-codex");
    expect(
      cache.getCredential({
        ...owner,
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      }),
    ).toBeNull();
  });

  it("isolates the same provider across owners and rejects stale generations", () => {
    const cache = new BrowserGatewayModelCredentialCache();
    grant(cache, { bearerToken: "owner-a" });
    grant(cache, {
      grantedByOwnerId: "other-owner",
      grantedByOwnerGenerationId: "other-generation-1",
      bearerToken: "owner-b",
    });

    expect(
      cache.getCredential({
        ...owner,
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      })?.bearerToken,
    ).toBe("owner-a");
    expect(
      cache.getCredential({
        grantedByOwnerId: "other-owner",
        grantedByOwnerGenerationId: "other-generation-1",
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      })?.bearerToken,
    ).toBe("owner-b");
    expect(
      cache.getCredential({
        grantedByOwnerId: owner.grantedByOwnerId,
        grantedByOwnerGenerationId: "stale-generation",
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      }),
    ).toBeNull();
    expect(
      cache.clear({
        grantedByOwnerId: owner.grantedByOwnerId,
        grantedByOwnerGenerationId: "stale-generation",
        providerId: "codex",
      }),
    ).toBeNull();
  });
});
