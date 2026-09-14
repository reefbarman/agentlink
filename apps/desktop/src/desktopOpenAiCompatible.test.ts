import { describe, expect, it, vi } from "vitest";

import type {
  SharedOpenAiCompatibleConfigStore,
  SharedOpenAiCompatibleCredentialStore,
} from "@agentlink/node-host";

import { DesktopOpenAiCompatibleController } from "./desktopOpenAiCompatible.js";

const connection = {
  id: "local",
  displayName: "Local API",
  baseUrl: "http://127.0.0.1:1234/v1",
  profile: "generic",
  reasoningEffortMode: "none",
  authKey: "local-key",
  models: [
    {
      id: "local-model",
      model: "wire-model",
      displayName: "Local Model",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      supportsToolUse: true,
    },
  ],
};

function createController(credential?: string) {
  const configStore = {
    read: vi.fn(async () => ({
      schemaVersion: 1 as const,
      connections: [connection],
    })),
  } as unknown as SharedOpenAiCompatibleConfigStore;
  const credentialStore = {
    get: vi.fn(async () => credential),
    store: vi.fn(),
    delete: vi.fn(),
    migrateLegacyIfAbsent: vi.fn(),
  } satisfies SharedOpenAiCompatibleCredentialStore;
  return {
    controller: new DesktopOpenAiCompatibleController({
      configStore,
      credentialStore,
    }),
    credentialStore,
  };
}

describe("DesktopOpenAiCompatibleController", () => {
  it("loads shared models and resolves their named Keychain credential", async () => {
    const { controller } = createController("secret");
    await controller.initialize();

    expect(controller.hasUsableModel()).toBe(true);
    expect(controller.getCredentialCount()).toBe(1);
    expect(controller.getModels()[0]).toMatchObject({
      id: "local-model",
      authenticated: true,
    });
    expect(controller.getRuntimeProfiles()).toHaveProperty(
      "openai-compatible:local",
    );
    await expect(
      controller.resolveModelAuth("openai-compatible:local"),
    ).resolves.toMatchObject({
      providerId: "openai-compatible:local",
      bearerToken: "secret",
    });
  });

  it("keeps missing-key models visible but unavailable", async () => {
    const { controller } = createController();
    await controller.initialize();

    expect(controller.hasUsableModel()).toBe(false);
    expect(controller.getCredentialCount()).toBe(0);
    expect(controller.getModels()[0]).toMatchObject({
      authenticated: false,
      readiness: { status: "credentials_required" },
    });
  });
});
