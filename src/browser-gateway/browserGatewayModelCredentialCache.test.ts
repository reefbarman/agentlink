import { describe, expect, it } from "vitest";

import { BrowserGatewayModelCredentialCache } from "./browserGatewayModelCredentialCache.js";

describe("BrowserGatewayModelCredentialCache", () => {
  it("normalizes VS Code Codex provider IDs to the browser credential provider ID", () => {
    const cache = new BrowserGatewayModelCredentialCache();

    const credential = cache.grant({
      providerId: "openai-codex",
      method: "oauth",
      bearerToken: "token",
      grantedByOwnerId: "vscode-owner",
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      now: 1_000,
    });

    expect(credential.providerId).toBe("openai-codex");
    expect(
      cache.getCredential({
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      })?.bearerToken,
    ).toBe("token");
    expect(
      cache.getStatus({
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      }),
    ).toMatchObject({ state: "ready", providerId: "openai-codex" });
  });

  it("clears Codex credentials through either Codex provider ID", () => {
    const cache = new BrowserGatewayModelCredentialCache();
    cache.grant({
      providerId: "codex",
      method: "apiKey",
      bearerToken: "token",
      grantedByOwnerId: "vscode-owner",
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      now: 1_000,
    });

    expect(cache.clear("openai-codex")?.providerId).toBe("openai-codex");
    expect(
      cache.getCredential({
        providerId: "codex",
        modelScope: "chat",
        now: 1_001,
      }),
    ).toBeNull();
  });
});
