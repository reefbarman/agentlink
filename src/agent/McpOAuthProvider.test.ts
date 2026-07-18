import { describe, it, expect } from "vitest";
import type * as vscode from "vscode";
import {
  cleanupOrphanedMcpOAuthState,
  McpOAuthProvider,
} from "./McpOAuthProvider.js";

class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) return this.store.get(key) as T;
    return defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

describe("McpOAuthProvider callback port reuse", () => {
  it("reuses cached localhost redirect port when available", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_client", {
      client_id: "cid",
      redirect_uris: ["http://localhost:45671/callback"],
    });

    const provider = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );

    await provider.start();

    try {
      expect(provider.redirectUrl).toBe("http://localhost:45671/callback");
    } finally {
      provider.stop();
    }
  });

  it("falls back to ephemeral port when cached localhost redirect port is unavailable", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_client", {
      client_id: "cid",
      redirect_uris: ["http://localhost:45672/callback"],
    });

    const first = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );
    await first.start();

    const second = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );

    try {
      await second.start();
      expect(second.redirectUrl).not.toBe("http://localhost:45672/callback");
      expect(second.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    } finally {
      second.stop();
      first.stop();
    }
  });
});

describe("McpOAuthProvider credential storage", () => {
  const serverUrl = "https://mcp.notion.example";
  const tokens = {
    access_token: "at",
    refresh_token: "rt",
    token_type: "bearer",
  };

  it("shares tokens between provider instances for the same server identity", async () => {
    const storage = new FakeMemento();
    const first = new McpOAuthProvider("notion", serverUrl, storage);
    await first.saveTokens(tokens);

    // A fresh provider (e.g. after a hub reload/new generation) must see the
    // same credentials — this was the reauth-loop regression.
    const second = new McpOAuthProvider("notion", serverUrl, storage);
    expect(await second.tokens()).toEqual(tokens);
  });

  it("isolates tokens between different server URLs with the same name", async () => {
    const storage = new FakeMemento();
    const first = new McpOAuthProvider("notion", serverUrl, storage);
    await first.saveTokens(tokens);

    const other = new McpOAuthProvider(
      "notion",
      "https://mcp.other.example",
      storage,
    );
    expect(await other.tokens()).toBeUndefined();
  });

  it("migrates legacy un-namespaced tokens to the server-identity key", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_tokens", tokens);

    const provider = new McpOAuthProvider("notion", serverUrl, storage);
    expect(await provider.tokens()).toEqual(tokens);
    expect(storage.get("mcp_oauth_notion_tokens")).toBeUndefined();

    const migratedKey = storage
      .keys()
      .find(
        (key) => key.startsWith("mcp_oauth_notion_") && key.endsWith("_tokens"),
      );
    expect(migratedKey).toBeDefined();
  });

  it("migrates legacy ask-agent-namespaced tokens", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_ask-agent_notion_tokens", tokens);

    const provider = new McpOAuthProvider("notion", serverUrl, storage);
    expect(await provider.tokens()).toEqual(tokens);
    expect(storage.get("mcp_oauth_ask-agent_notion_tokens")).toBeUndefined();
  });

  it("does not resurrect invalidated credentials from legacy keys", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_tokens", tokens);
    await storage.update("mcp_oauth_ask-agent_notion_tokens", tokens);

    const provider = new McpOAuthProvider("notion", serverUrl, storage);
    await provider.invalidateCredentials("all");

    expect(await provider.tokens()).toBeUndefined();
    expect(storage.keys()).toEqual([]);
  });

  it("cleans up orphaned generation-scoped project credentials", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_project-abc123-4_notion_tokens", tokens);
    await storage.update("mcp_oauth_project-mcp-2_notion_client", {
      client_id: "cid",
    });
    await storage.update("mcp_oauth_notion_tokens", tokens);
    await storage.update("unrelated_key", "keep");

    await cleanupOrphanedMcpOAuthState(storage);

    expect([...storage.keys()].sort()).toEqual([
      "mcp_oauth_notion_tokens",
      "unrelated_key",
    ]);
  });
});
