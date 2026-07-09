import {
  DEFAULT_ACP_INIT_TIMEOUT_MS,
  NATIVE_BACKGROUND_AGENT,
  normalizeBackgroundAgentSettings,
  parseAcpBackgroundAgentId,
  redactAcpBackgroundAgentConfig,
  resolveAcpBackgroundAgent,
} from "./acpAgentConfig.js";
import { describe, expect, it } from "vitest";

describe("ACP background agent config", () => {
  it("defaults to native background routing", () => {
    const settings = normalizeBackgroundAgentSettings({});

    expect(settings.defaultAgent).toBe(NATIVE_BACKGROUND_AGENT);
    expect(settings.acpAgents).toEqual([]);
  });

  it("normalizes configured ACP agents", () => {
    const settings = normalizeBackgroundAgentSettings({
      defaultAgent: "acp:claude",
      acpAgents: [
        {
          id: "claude",
          label: "Claude via ACP",
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
      acpAgents: [
        {
          id: "claude",
          label: "Claude via ACP",
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
