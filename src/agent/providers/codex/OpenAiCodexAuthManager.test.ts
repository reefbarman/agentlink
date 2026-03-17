import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OpenAiCodexAuthManager,
  type OpenAiApiKeyCredential,
} from "./OpenAiCodexAuthManager.js";

describe("OpenAiCodexAuthManager", () => {
  const oauthManager = {
    onAuthStateChanged: undefined as (() => void) | undefined,
    initialize: vi.fn(),
    isAuthenticated: vi.fn(),
    getAccessToken: vi.fn(),
    getAccountId: vi.fn(),
    getEmail: vi.fn(),
    forceRefreshAccessToken: vi.fn(),
    clearCredentials: vi.fn(),
    startAuthorizationFlow: vi.fn(),
    waitForCallback: vi.fn(),
  };

  const context = {
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
    },
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  let manager: OpenAiCodexAuthManager;

  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    oauthManager.getAccessToken.mockResolvedValue(null);
    oauthManager.getAccountId.mockResolvedValue(null);
    oauthManager.forceRefreshAccessToken.mockResolvedValue(null);
    context.secrets.get.mockResolvedValue(undefined);
    context.globalState.get.mockReturnValue(undefined);
    context.globalState.update.mockResolvedValue(undefined);
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    manager = new OpenAiCodexAuthManager(oauthManager as any);
    manager.initialize(context);
  });

  it("prefers OAuth over API key when both are available", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(true);
    oauthManager.getAccessToken.mockResolvedValue("oauth-token");
    oauthManager.getAccountId.mockResolvedValue("acct-123");
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveModelAuth();

    expect(auth).toEqual({
      method: "oauth",
      bearerToken: "oauth-token",
      accountId: "acct-123",
      canRefresh: true,
    });
  });

  it("uses API key for embeddings when no OAuth session is configured", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toEqual({
      method: "apiKey",
      bearerToken: "api-key",
      canRefresh: false,
    });
  });

  it("does not use embeddings-only API key for model auth", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue("embeddings-only");

    const auth = await manager.resolveModelAuth();

    expect(auth).toBeNull();
  });

  it("uses legacy stored API key for model auth when scope is missing", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue(undefined);

    const auth = await manager.resolveModelAuth();

    expect(auth).toEqual({
      method: "apiKey",
      bearerToken: "api-key",
      canRefresh: false,
    });
  });

  it("returns null embedding auth when no API key is configured", async () => {
    context.secrets.get.mockResolvedValue(undefined);

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toBeNull();
  });

  it("uses API key for embeddings even when OAuth is configured", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(true);
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toEqual({
      method: "apiKey",
      bearerToken: "api-key",
      canRefresh: false,
    });
  });

  it("stores API key with explicit scope", async () => {
    await manager.storeApiKey("api-key", "embeddings-only");

    expect(context.secrets.store).toHaveBeenCalledWith(
      "openaiApiKey",
      "api-key",
    );
    expect(context.globalState.update).toHaveBeenCalledWith(
      "openaiApiKeyScope",
      "embeddings-only",
    );
  });

  it("keeps models+embeddings scope when re-saving the same key as embeddings-only", async () => {
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue("models+embeddings");

    await manager.storeApiKey("api-key", "embeddings-only");

    expect(context.globalState.update).toHaveBeenCalledWith(
      "openaiApiKeyScope",
      "models+embeddings",
    );
  });

  it("allows switching to embeddings-only when saving a different key", async () => {
    context.secrets.get.mockResolvedValue("old-key");
    context.globalState.get.mockReturnValue("models+embeddings");

    await manager.storeApiKey("new-key", "embeddings-only");

    expect(context.globalState.update).toHaveBeenCalledWith(
      "openaiApiKeyScope",
      "embeddings-only",
    );

    context.secrets.get.mockResolvedValue("new-key");
    context.globalState.get.mockReturnValue("embeddings-only");
    oauthManager.isAuthenticated.mockResolvedValue(false);

    const modelAuth = await manager.resolveModelAuth();
    expect(modelAuth).toBeNull();

    const embeddingAuth = await manager.resolveEmbeddingAuth();
    expect(embeddingAuth).toEqual({
      method: "apiKey",
      bearerToken: "new-key",
      canRefresh: false,
    });
  });

  it("returns null when force-refreshing apiKey model auth with embeddings-only scope", async () => {
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue("embeddings-only");

    const auth = await manager.forceRefreshModelAuth("apiKey");

    expect(auth).toBeNull();
  });

  it("reads OPENAI_API_KEY env key with models+embeddings scope", async () => {
    context.secrets.get.mockResolvedValue(undefined);
    process.env.OPENAI_API_KEY = "env-key";

    const cred =
      (await manager.getApiKeyCredential()) as OpenAiApiKeyCredential | null;

    expect(cred).toEqual({
      apiKey: "env-key",
      source: "env",
      scope: "models+embeddings",
    });
  });

  it("refreshes OAuth auth when forced for oauth method", async () => {
    oauthManager.forceRefreshAccessToken.mockResolvedValue("refreshed-token");
    oauthManager.getAccountId.mockResolvedValue("acct-456");

    const auth = await manager.forceRefreshModelAuth("oauth");

    expect(auth).toEqual({
      method: "oauth",
      bearerToken: "refreshed-token",
      accountId: "acct-456",
      canRefresh: true,
    });
  });
});
