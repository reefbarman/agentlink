import { describe, expect, it } from "vitest";

import { normalizeBackgroundAgentSettings } from "./acpAgentConfig.js";
import { resolveBackgroundBackendRoute } from "./backgroundBackendRouter.js";

describe("resolveBackgroundBackendRoute", () => {
  it("uses native routing by default", () => {
    const settings = normalizeBackgroundAgentSettings({});

    expect(resolveBackgroundBackendRoute(settings, {})).toEqual({
      backend: "native",
    });
  });

  it("routes to default ACP agent", () => {
    const settings = normalizeBackgroundAgentSettings({
      defaultAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    const route = resolveBackgroundBackendRoute(settings, {});

    expect(route).toMatchObject({
      backend: "acp",
      reference: "acp:claude",
      reason: "default_agent",
      agent: { id: "claude", command: "claude-agent-acp" },
    });
  });

  it("falls back to native when the configured ACP agent is cooling down", () => {
    const settings = normalizeBackgroundAgentSettings({
      defaultAgent: "acp:claude",
      reviewAgent: "acp:claude",
      acpAgents: [
        { id: "claude", command: "claude-agent-acp", provider: "anthropic" },
      ],
    });
    const context = {
      foregroundProvider: "codex",
      unavailableReferences: new Set(["acp:claude"]),
    };

    expect(resolveBackgroundBackendRoute(settings, {}, context)).toEqual({
      backend: "native",
      fallback: {
        reason: "unavailable_reference",
        reference: "acp:claude",
      },
    });
    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        context,
      ),
    ).toEqual({
      backend: "native",
      fallback: {
        reason: "unavailable_reference",
        reference: "acp:claude",
      },
    });
    // An explicit override still wins during the cooldown.
    expect(
      resolveBackgroundBackendRoute(
        settings,
        { provider: "acp:claude" },
        context,
      ),
    ).toMatchObject({ backend: "acp", reason: "explicit_provider" });
  });

  it("explicit ACP provider beats native default", () => {
    const settings = normalizeBackgroundAgentSettings({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    const route = resolveBackgroundBackendRoute(settings, {
      provider: "acp:claude",
    });

    expect(route).toMatchObject({
      backend: "acp",
      reference: "acp:claude",
      reason: "explicit_provider",
      agent: { id: "claude" },
    });
  });

  it("explicit native provider keeps native routing even when default is native", () => {
    const settings = normalizeBackgroundAgentSettings({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(
      resolveBackgroundBackendRoute(settings, { provider: "anthropic" }),
    ).toEqual({ backend: "native" });
  });

  it("routes review tasks to an adversarial ACP agent", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [
        {
          id: "claude",
          provider: "anthropic",
          command: "claude-agent-acp",
        },
      ],
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "codex" },
      ),
    ).toMatchObject({
      backend: "acp",
      reference: "acp:claude",
      reason: "review_agent",
      agent: { id: "claude", provider: "anthropic" },
    });
  });

  it("preserves native cross-provider review when the foreground matches the ACP provider", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [
        {
          id: "claude",
          provider: "anthropic",
          command: "claude-agent-acp",
        },
      ],
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_plan" },
        { foregroundProvider: "anthropic" },
      ),
    ).toEqual({ backend: "native" });
  });

  it("does not apply the review preference to non-review tasks", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(
      resolveBackgroundBackendRoute(settings, {
        taskClass: "readonly-research",
      }),
    ).toEqual({ backend: "native" });
  });

  it("requires provider metadata for a configured review ACP agent", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(() =>
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "codex" },
      ),
    ).toThrow(/requires a provider/);
  });

  it("lets an explicit native provider override the review preference", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(
      resolveBackgroundBackendRoute(settings, {
        provider: "codex",
        taskClass: "review_code",
      }),
    ).toEqual({ backend: "native" });
  });

  it("lets an explicit native model override the review preference", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [
        {
          id: "claude",
          provider: "anthropic",
          command: "claude-agent-acp",
        },
      ],
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        {
          model: "gpt-5.6-sol",
          taskClass: "review_code",
        },
        { foregroundProvider: "codex" },
      ),
    ).toEqual({ backend: "native" });
  });

  it("throws for unknown explicit ACP provider", () => {
    const settings = normalizeBackgroundAgentSettings({});

    expect(() =>
      resolveBackgroundBackendRoute(settings, { provider: "acp:missing" }),
    ).toThrow(/Unknown ACP background agent/);
  });
});
