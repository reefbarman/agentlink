import {
  DEFAULT_CODEX_MODELS,
  DEFAULT_OPENAI_MODELS,
  compatibleCredentialAccount,
  parseCliConfig,
} from "./config.js";
import { describe, expect, it } from "vitest";

const base = {
  schemaVersion: 1,
  defaultModel: { providerId: "codex", modelId: "gpt-5.6-sol" },
  openAiModels: ["gpt-5.6-sol"],
  codexModels: ["gpt-5.6-sol"],
};

describe("parseCliConfig", () => {
  it("uses the maintained extension model catalogues for fresh CLI config", () => {
    expect(DEFAULT_CODEX_MODELS).toEqual(
      expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    );
    expect(DEFAULT_CODEX_MODELS).toHaveLength(7);
    expect(DEFAULT_OPENAI_MODELS).toEqual(DEFAULT_CODEX_MODELS);
  });

  it("rejects secret-account overrides and unsafe compatible endpoints", () => {
    const provider = {
      id: "custom",
      baseURL: "https://example.invalid/v1",
      credentialAccount: "codex-oauth-credentials",
      models: [
        {
          id: "model",
          contextWindow: 8_192,
          maxOutputTokens: 1_024,
          supportsToolUse: true,
        },
      ],
    };
    const parsed = parseCliConfig({
      ...base,
      compatibleProviders: [provider],
    });

    expect(parsed.compatibleProviders[0]).not.toHaveProperty(
      "credentialAccount",
    );
    expect(compatibleCredentialAccount(parsed.compatibleProviders[0]!)).toBe(
      "openai-compatible-api-key:custom",
    );
    expect(() =>
      parseCliConfig({
        ...base,
        compatibleProviders: [
          { ...provider, baseURL: "http://attacker.invalid/v1" },
        ],
      }),
    ).toThrow("must use HTTPS or loopback HTTP");
  });

  it("accepts explicit loopback HTTP metadata with no secret override", () => {
    const parsed = parseCliConfig({
      ...base,
      compatibleProviders: [
        {
          id: "local",
          baseURL: "http://127.0.0.1:1234/v1",
          noAuth: true,
          allowInsecureHttp: true,
          models: [
            {
              id: "local-model",
              contextWindow: 8_192,
              maxOutputTokens: 1_024,
              supportsToolUse: true,
            },
          ],
        },
      ],
    });

    expect(parsed.compatibleProviders[0]).toMatchObject({
      id: "local",
      noAuth: true,
      allowInsecureHttp: true,
    });
  });
});
