import {
  buildDesktopCodexCatalog,
  buildDesktopOpenAiCompatibleCatalog,
} from "./desktopModelCatalog.js";
import { describe, expect, it } from "vitest";
import {
  isCodexModelServedOnChatgptBackend,
  listCodexModels,
} from "@agentlink/core/codex";

describe("desktop model catalog", () => {
  it("matches the ChatGPT/Codex OAuth model filter used by VS Code", () => {
    const modelIds = buildDesktopCodexCatalog("oauth").map((model) => model.id);
    const expectedModelIds = listCodexModels("openai-codex", "oauth")
      .filter((model) => isCodexModelServedOnChatgptBackend(model.id))
      .map((model) => model.id);

    expect(modelIds).toEqual(expectedModelIds);
    expect(modelIds).not.toContain("gpt-5.4-pro");
  });

  it("marks shared OpenAI-compatible models ready only with required credentials", () => {
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

    expect(
      buildDesktopOpenAiCompatibleCatalog([connection]).models[0],
    ).toMatchObject({
      providerId: "openai-compatible:local",
      authenticated: false,
      readiness: { status: "credentials_required" },
    });
    expect(
      buildDesktopOpenAiCompatibleCatalog([connection], new Set(["local-key"]))
        .models[0],
    ).toMatchObject({ authenticated: true, readiness: { status: "ready" } });
  });

  it("keeps the full maintained catalog for OpenAI API keys", () => {
    const modelIds = buildDesktopCodexCatalog("apiKey").map(
      (model) => model.id,
    );

    expect(modelIds).toContain("gpt-6-astra");
    expect(modelIds).toContain("gpt-5.4-pro");
    expect(modelIds).not.toContain("gpt-5.3-codex-spark");
  });
});
