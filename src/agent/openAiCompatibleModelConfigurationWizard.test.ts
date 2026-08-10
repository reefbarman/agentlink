import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OpenAiCompatibleCredentialService,
  type OpenAiCompatibleCredentialServiceDependencies,
} from "./openAiCompatibleCredentials.js";
import {
  configureOpenAiCompatibleModel,
  generateConnectionId,
  type OpenAiCompatibleModelConfigurationWizardDependencies,
} from "./openAiCompatibleModelConfigurationWizard.js";
import { getOpenAiCompatibleSecretKey } from "./openAiCompatibleSecrets.js";
import { normalizeOpenAiCompatibleConnections } from "./providers/openaiCompatible/config.js";
import type { DiscoveredOpenAiCompatibleModel } from "./providers/openaiCompatible/modelDiscovery.js";

const {
  showQuickPick,
  showInputBox,
  showWarningMessage,
  showErrorMessage,
  showInformationMessage,
  withProgress,
} = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  withProgress: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    showQuickPick,
    showInputBox,
    showWarningMessage,
    showErrorMessage,
    showInformationMessage,
    withProgress,
  },
  ProgressLocation: { Notification: 15 },
  commands: { registerCommand: vi.fn() },
}));

interface Harness {
  dependencies: OpenAiCompatibleModelConfigurationWizardDependencies;
  secretValues: Map<string, string>;
  secretStore: ReturnType<typeof vi.fn>;
  secretDelete: ReturnType<typeof vi.fn>;
  stateUpdate: ReturnType<typeof vi.fn>;
  updateGlobalConnections: ReturnType<typeof vi.fn>;
  refreshProviders: ReturnType<typeof vi.fn>;
  getConnections(): unknown;
  setConnections(value: unknown): void;
}

function discoveredModel(): DiscoveredOpenAiCompatibleModel {
  return {
    model: "moonshotai/kimi-k3",
    displayName: "MoonshotAI: Kimi K3",
    contextWindow: 1_048_576,
    maxOutputTokens: 4_096,
    supportsToolUse: true,
    supportsThinking: true,
    supportsImages: true,
    reasoningEfforts: ["max", "high", "low"],
    defaultReasoningEffort: "max" as const,
    provenance: {
      displayName: "discovered" as const,
      contextWindow: "discovered" as const,
      maxOutputTokens: "default" as const,
      supportsToolUse: "discovered" as const,
      supportsThinking: "discovered" as const,
      supportsImages: "discovered" as const,
      reasoningEfforts: "discovered" as const,
      defaultReasoningEffort: "discovered" as const,
    },
  };
}

function createHarness(options?: {
  connections?: unknown;
  indexed?: string[];
  secrets?: Record<string, string>;
  reservedModelIds?: string[];
}): Harness {
  let connections: unknown = options?.connections ?? [];
  let indexed = [...(options?.indexed ?? [])];
  const secretValues = new Map(Object.entries(options?.secrets ?? {}));
  const secretStore = vi.fn(async (key: string, value: string) => {
    secretValues.set(key, value);
  });
  const secretDelete = vi.fn(async (key: string) => {
    secretValues.delete(key);
  });
  const stateUpdate = vi.fn(async (_key: string, value: unknown) => {
    indexed = value as string[];
  });
  const credentialDependencies: OpenAiCompatibleCredentialServiceDependencies =
    {
      secrets: {
        get: vi.fn(async (key: string) => secretValues.get(key)),
        store: secretStore,
        delete: secretDelete,
      },
      state: {
        get: <T>(_key: string, fallback: T): T =>
          (indexed.length ? [...indexed] : fallback) as T,
        update: stateUpdate,
      },
      getConfiguredApiKeyNames: () => [],
    };
  const credentials = new OpenAiCompatibleCredentialService(
    credentialDependencies,
  );
  const updateGlobalConnections = vi.fn(async (value: unknown) => {
    connections = value;
  });
  const refreshProviders = vi.fn(async () => ({ applied: true }));
  return {
    dependencies: {
      credentials,
      getGlobalConnections: () => connections,
      updateGlobalConnections,
      validateConnections: (raw) =>
        normalizeOpenAiCompatibleConnections(raw, {
          builtInModelIds: options?.reservedModelIds,
        }),
      getReservedModelIds: () => options?.reservedModelIds ?? [],
      refreshProviders,
      discoverModels: vi.fn(async () => [discoveredModel()]),
      openSettings: vi.fn(),
    },
    secretValues,
    secretStore,
    secretDelete,
    stateUpdate,
    updateGlobalConnections,
    refreshProviders,
    getConnections: () => connections,
    setConnections: (value) => {
      connections = value;
    },
  };
}

function quickPickBy(
  ...selectors: Array<(items: readonly unknown[]) => unknown>
): void {
  for (const selector of selectors) {
    showQuickPick.mockImplementationOnce(async (items: readonly unknown[]) =>
      selector(items),
    );
  }
}

function itemWith(
  key: string,
  value: unknown,
): (items: readonly unknown[]) => unknown {
  return (items) =>
    items.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>)[key] === value,
    );
}

describe("OpenAI-compatible model configuration wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withProgress.mockImplementation(
      async (_options, task: (progress: unknown, token: unknown) => unknown) =>
        await task(
          {},
          { onCancellationRequested: () => ({ dispose: vi.fn() }) },
        ),
    );
  });

  it("stages a new OpenRouter key, saves one model/connection, then indexes it", async () => {
    const harness = createHarness();
    quickPickBy(
      itemWith("profile", "openrouter"),
      itemWith("action", "create"),
      itemWith("description", discoveredModel().model),
      itemWith("action", "save"),
    );
    showInputBox
      .mockResolvedValueOnce("tris-agentlink")
      .mockResolvedValueOnce("super-secret")
      .mockResolvedValueOnce("Kimi K3");

    await configureOpenAiCompatibleModel(harness.dependencies);

    expect(harness.secretStore).toHaveBeenCalledWith(
      getOpenAiCompatibleSecretKey("tris-agentlink"),
      "super-secret",
    );
    expect(harness.updateGlobalConnections).toHaveBeenCalledOnce();
    expect(harness.refreshProviders).toHaveBeenCalledOnce();
    expect(harness.stateUpdate).toHaveBeenCalledWith(
      "openaiCompatible.authKeyNames.v1",
      ["tris-agentlink"],
    );
    expect(harness.getConnections()).toEqual([
      expect.objectContaining({
        id: "openrouter-moonshotai-kimi-k3",
        baseUrl: "https://openrouter.ai/api/v1",
        profile: "openrouter",
        authKey: "tris-agentlink",
        models: [
          expect.objectContaining({
            id: "openrouter-moonshotai-kimi-k3",
            model: "moonshotai/kimi-k3",
            displayName: "Kimi K3",
            supportsToolUse: true,
            supportsThinking: true,
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(harness.getConnections())).not.toContain(
      "super-secret",
    );
  });

  it("reuses an existing credential without rewriting or re-indexing it", async () => {
    const key = getOpenAiCompatibleSecretKey("openrouter-main");
    const harness = createHarness({
      indexed: ["openrouter-main"],
      secrets: { [key]: "existing-secret" },
    });
    quickPickBy(
      itemWith("profile", "openrouter"),
      itemWith("apiKeyName", "openrouter-main"),
      itemWith("description", discoveredModel().model),
      itemWith("action", "save"),
    );
    showInputBox.mockResolvedValueOnce("Kimi K3");

    await configureOpenAiCompatibleModel(harness.dependencies);

    expect(harness.secretStore).not.toHaveBeenCalled();
    expect(harness.stateUpdate).not.toHaveBeenCalled();
    expect(harness.getConnections()).toEqual([
      expect.objectContaining({ authKey: "openrouter-main" }),
    ]);
  });

  it("supports a generic no-auth endpoint with manual discovery fallback", async () => {
    const harness = createHarness();
    harness.dependencies.discoverModels = vi.fn(async () => {
      throw new Error("models endpoint unavailable");
    });
    quickPickBy(
      itemWith("profile", "generic"),
      itemWith("reasoningEffortMode", "none"),
      itemWith("action", "none"),
      itemWith("action", "save"),
    );
    showInputBox
      .mockResolvedValueOnce("http://127.0.0.1:1234/v1")
      .mockResolvedValueOnce("loaded-model")
      .mockResolvedValueOnce("Local model");
    showWarningMessage.mockResolvedValueOnce("Enter Model ID Manually");

    await configureOpenAiCompatibleModel(harness.dependencies);

    expect(harness.getConnections()).toEqual([
      expect.objectContaining({
        id: "custom-loaded-model",
        baseUrl: "http://127.0.0.1:1234/v1",
        profile: "generic",
        reasoningEffortMode: "none",
        models: [
          expect.objectContaining({
            model: "loaded-model",
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
            supportsToolUse: false,
          }),
        ],
      }),
    ]);
    expect(
      (harness.getConnections() as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("authKey");
  });

  it("cancels without any state or secret writes", async () => {
    const harness = createHarness();
    showQuickPick.mockResolvedValueOnce(undefined);

    await configureOpenAiCompatibleModel(harness.dependencies);

    expect(harness.updateGlobalConnections).not.toHaveBeenCalled();
    expect(harness.secretStore).not.toHaveBeenCalled();
    expect(harness.stateUpdate).not.toHaveBeenCalled();
    expect(harness.refreshProviders).not.toHaveBeenCalled();
  });

  it("rebases onto changed settings, reconfirms, and suffixes colliding IDs", async () => {
    const initialExisting = {
      id: "existing",
      displayName: "Existing",
      baseUrl: "http://127.0.0.1:1234/v1",
      profile: "generic",
      models: [
        {
          id: "existing-model",
          model: "existing-model",
          displayName: "Existing",
          contextWindow: 32_768,
          maxOutputTokens: 4_096,
          supportsToolUse: false,
        },
      ],
    };
    const concurrent = {
      ...initialExisting,
      id: "openrouter-moonshotai-kimi-k3",
      models: [
        {
          ...initialExisting.models[0],
          id: "openrouter-moonshotai-kimi-k3",
        },
      ],
    };
    const harness = createHarness({ connections: [initialExisting] });
    quickPickBy(
      itemWith("profile", "openrouter"),
      itemWith("action", "create"),
      itemWith("description", discoveredModel().model),
      (items) => {
        harness.setConnections([initialExisting, concurrent]);
        return itemWith("action", "save")(items);
      },
    );
    showInputBox
      .mockResolvedValueOnce("new-key")
      .mockResolvedValueOnce("secret")
      .mockResolvedValueOnce("Kimi K3");
    showWarningMessage.mockResolvedValueOnce("Review and Save Latest");

    await configureOpenAiCompatibleModel(harness.dependencies);

    const saved = harness.getConnections() as Array<{
      id: string;
      models: Array<{ id: string }>;
    }>;
    expect(saved).toHaveLength(3);
    expect(saved[2]?.id).toBe("openrouter-moonshotai-kimi-k3-2");
    expect(saved[2]?.models[0]?.id).toBe("openrouter-moonshotai-kimi-k3-2");
  });

  it("restores settings and removes only its unchanged staged key on refresh failure", async () => {
    const harness = createHarness();
    harness.refreshProviders.mockResolvedValueOnce({
      applied: false,
      issues: [{ path: "$", message: "registry rejected candidate" }],
    });
    quickPickBy(
      itemWith("profile", "openrouter"),
      itemWith("action", "create"),
      itemWith("description", discoveredModel().model),
      itemWith("action", "save"),
    );
    showInputBox
      .mockResolvedValueOnce("rollback-key")
      .mockResolvedValueOnce("secret")
      .mockResolvedValueOnce("Kimi K3");

    await expect(
      configureOpenAiCompatibleModel(harness.dependencies),
    ).rejects.toThrow("registry rejected candidate");

    expect(harness.getConnections()).toEqual([]);
    expect(harness.secretDelete).toHaveBeenCalledWith(
      getOpenAiCompatibleSecretKey("rollback-key"),
    );
    expect(harness.stateUpdate).not.toHaveBeenCalled();
  });
});

describe("generateConnectionId", () => {
  it("normalizes, bounds, and suffixes collisions across settings and reserved IDs", () => {
    const longId = generateConnectionId("generic", "X".repeat(300), [], []);
    expect(longId).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(longId.length).toBeLessThanOrEqual(128);

    expect(
      generateConnectionId(
        "openrouter",
        "moonshotai/kimi-k3",
        [
          {
            id: "other",
            models: [{ id: "openrouter-moonshotai-kimi-k3" }],
          },
        ],
        ["openrouter-moonshotai-kimi-k3-2"],
      ),
    ).toBe("openrouter-moonshotai-kimi-k3-3");
  });
});
