import {
  DEFAULT_ACP_INIT_TIMEOUT_MS,
  NATIVE_BACKGROUND_AGENT,
  normalizeBackgroundAgentSettings,
  parseAcpBackgroundAgentId,
  parseBackgroundReviewTarget,
  redactAcpBackgroundAgentConfig,
  resolveAcpBackgroundAgent,
} from "./acpAgentConfig.js";
import { describe, expect, it } from "vitest";

describe("ACP background agent config", () => {
  it("defaults to native background routing", () => {
    const settings = normalizeBackgroundAgentSettings({});

    expect(settings.defaultAgent).toBe(NATIVE_BACKGROUND_AGENT);
    expect(settings.reviewAgent).toBe(NATIVE_BACKGROUND_AGENT);
    expect(settings.reviewTarget).toEqual({});
    expect(settings.acpAgents).toEqual([]);
    expect(parseBackgroundReviewTarget(settings)).toEqual({ kind: "native" });
  });

  it("normalizes configured ACP agents", () => {
    const settings = normalizeBackgroundAgentSettings({
      defaultAgent: "acp:claude",
      reviewAgent: "acp:claude",
      acpAgents: [
        {
          id: "claude",
          label: "Claude via ACP",
          provider: "Anthropic",
          command: "claude-agent-acp",
          args: ["--debug"],
          env: { SECRET: "value" },
          initTimeoutMs: 12_345,
          readonlyOnly: false,
        },
      ],
    });

    expect(settings).toEqual({
      defaultAgent: "acp:claude",
      reviewAgent: "acp:claude",
      reviewTarget: {},
      acpAgents: [
        {
          id: "claude",
          label: "Claude via ACP",
          provider: "anthropic",
          command: "claude-agent-acp",
          args: ["--debug"],
          env: { SECRET: "value" },
          initTimeoutMs: 12_345,
          readonlyOnly: false,
        },
      ],
    });
  });

  it("applies ACP agent defaults", () => {
    const settings = normalizeBackgroundAgentSettings({
      acpAgents: [{ id: "gemini", command: "gemini-acp" }],
    });

    expect(settings.acpAgents[0]).toMatchObject({
      id: "gemini",
      label: "gemini",
      command: "gemini-acp",
      args: [],
      env: {},
      initTimeoutMs: DEFAULT_ACP_INIT_TIMEOUT_MS,
      readonlyOnly: true,
    });
  });

  it("rejects unsupported default agent values", () => {
    expect(() =>
      normalizeBackgroundAgentSettings({ defaultAgent: "native:anthropic" }),
    ).toThrow(/Unsupported background default agent/);
  });

  it("rejects unsupported review agent values", () => {
    expect(() =>
      normalizeBackgroundAgentSettings({ reviewAgent: "anthropic" }),
    ).toThrow(/Unsupported background review agent/);
  });

  it("falls back to the legacy review agent when no review target is set", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(parseBackgroundReviewTarget(settings)).toEqual({
      kind: "acp",
      reference: "acp:claude",
    });
  });

  it("prefers an explicit review target over the legacy review agent", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      reviewTarget: {
        default: { target: " model:custom-claude-opus-4-8 ", effort: " max " },
      },
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(settings.reviewTarget).toEqual({
      default: { target: "model:custom-claude-opus-4-8", effort: "max" },
    });
    expect(parseBackgroundReviewTarget(settings)).toEqual({
      kind: "model",
      modelId: "custom-claude-opus-4-8",
      effort: "max",
    });
  });

  it("supports native and ACP review targets", () => {
    expect(
      parseBackgroundReviewTarget(
        normalizeBackgroundAgentSettings({
          reviewAgent: "acp:claude",
          reviewTarget: { default: { target: "native:auto", effort: "high" } },
          acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
        }),
      ),
    ).toEqual({ kind: "native", effort: "high" });

    expect(
      parseBackgroundReviewTarget(
        normalizeBackgroundAgentSettings({
          reviewTarget: { default: { target: "acp:claude" } },
          acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
        }),
      ),
    ).toEqual({ kind: "acp", reference: "acp:claude" });
  });

  it("reports malformed review targets without failing normalization", () => {
    for (const target of ["anthropic", "model:", "acp:"]) {
      const settings = normalizeBackgroundAgentSettings({
        reviewTarget: { default: { target } },
      });
      expect(parseBackgroundReviewTarget(settings)).toEqual({
        kind: "invalid",
        value: target,
      });
    }
  });

  it("rejects an unsupported effort value", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: {
        default: { target: "model:custom-claude-opus-4-8", effort: "turbo" },
      },
    });

    expect(parseBackgroundReviewTarget(settings)).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("turbo"),
    });
  });

  it("rejects an effort pinned alongside an ACP target", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "acp:claude", effort: "high" } },
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(parseBackgroundReviewTarget(settings)).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("control their own reasoning effort"),
    });
  });

  it("selects a review target by foreground provider", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: {
        Codex: { target: "model:custom-claude-opus-4-8", effort: "max" },
        "openai-compatible:custom-claude": { target: "model:gpt-5.6-sol" },
        default: { target: "acp:claude" },
      },
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(parseBackgroundReviewTarget(settings, "codex")).toEqual({
      kind: "model",
      modelId: "custom-claude-opus-4-8",
      effort: "max",
    });
    expect(
      parseBackgroundReviewTarget(settings, "openai-compatible:custom-claude"),
    ).toEqual({ kind: "model", modelId: "gpt-5.6-sol" });
    expect(parseBackgroundReviewTarget(settings, "anthropic")).toEqual({
      kind: "acp",
      reference: "acp:claude",
    });
  });

  it("falls back to the legacy review agent when no entry matches", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      reviewTarget: {
        codex: { target: "model:custom-claude-opus-4-8" },
      },
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(parseBackgroundReviewTarget(settings, "anthropic")).toEqual({
      kind: "acp",
      reference: "acp:claude",
    });
    expect(parseBackgroundReviewTarget(settings)).toEqual({
      kind: "acp",
      reference: "acp:claude",
    });
  });

  it("rejects malformed provider-map entries", () => {
    expect(() =>
      normalizeBackgroundAgentSettings({
        reviewTarget: { codex: "model:custom-claude-opus-4-8" } as unknown,
      }),
    ).toThrow(/reviewTarget.codex must be an object with a target/);

    expect(() =>
      normalizeBackgroundAgentSettings({
        reviewTarget: { codex: { target: "  " } } as unknown,
      }),
    ).toThrow(/reviewTarget.codex.target must be a non-empty string/);

    expect(() =>
      normalizeBackgroundAgentSettings({
        reviewTarget: {
          codex: { target: "native:auto", effort: 3 },
        } as unknown,
      }),
    ).toThrow(/reviewTarget.codex.effort must be a string/);
  });

  it("rejects model targets for the default agent", () => {
    expect(() =>
      normalizeBackgroundAgentSettings({
        defaultAgent: "model:custom-claude-opus-4-8",
      }),
    ).toThrow(/Unsupported background default agent/);
  });

  it("rejects duplicate ACP agent ids", () => {
    expect(() =>
      normalizeBackgroundAgentSettings({
        acpAgents: [
          { id: "claude", command: "claude-agent-acp" },
          { id: "claude", command: "other" },
        ],
      }),
    ).toThrow(/Duplicate ACP background agent id/);
  });

  it("resolves ACP references", () => {
    const settings = normalizeBackgroundAgentSettings({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(resolveAcpBackgroundAgent(settings, "acp:claude").command).toBe(
      "claude-agent-acp",
    );
    expect(parseAcpBackgroundAgentId("acp:claude")).toBe("claude");
  });

  it("rejects unknown ACP references", () => {
    const settings = normalizeBackgroundAgentSettings({});

    expect(() => resolveAcpBackgroundAgent(settings, "acp:missing")).toThrow(
      /Unknown ACP background agent/,
    );
  });

  it("redacts env values", () => {
    const settings = normalizeBackgroundAgentSettings({
      acpAgents: [
        {
          id: "claude",
          command: "claude-agent-acp",
          env: { API_KEY: "secret", OTHER: "value" },
        },
      ],
    });

    expect(redactAcpBackgroundAgentConfig(settings.acpAgents[0]).env).toEqual({
      API_KEY: "***",
      OTHER: "***",
    });
  });
});
