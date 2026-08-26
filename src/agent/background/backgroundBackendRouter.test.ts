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

  it("falls back to native for images routed through an automatic default ACP agent", () => {
    const settings = normalizeBackgroundAgentSettings({
      defaultAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(
      resolveBackgroundBackendRoute(settings, {
        images: [
          { name: "diagram.png", mimeType: "image/png", base64: "AA==" },
        ],
      }),
    ).toEqual({
      backend: "native",
      fallback: {
        reason: "images_unsupported",
        reference: "acp:claude",
      },
    });
  });

  it("falls back to native for images routed through an automatic review ACP agent", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [
        { id: "claude", provider: "anthropic", command: "claude-agent-acp" },
      ],
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        {
          taskClass: "review_code",
          images: [
            { name: "diagram.png", mimeType: "image/png", base64: "AA==" },
          ],
        },
        { foregroundProvider: "codex" },
      ),
    ).toEqual({
      backend: "native",
      fallback: {
        reason: "images_unsupported",
        reference: "acp:claude",
      },
    });
  });

  it("keeps same-provider review fall-through when images are present", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [
        { id: "claude", provider: "anthropic", command: "claude-agent-acp" },
      ],
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        {
          taskClass: "review_code",
          images: [
            { name: "diagram.png", mimeType: "image/png", base64: "AA==" },
          ],
        },
        { foregroundProvider: "anthropic" },
      ),
    ).toEqual({ backend: "native" });
  });

  it("validates an automatic ACP review agent before image fallback", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(() =>
      resolveBackgroundBackendRoute(settings, {
        taskClass: "review_code",
        images: [
          { name: "diagram.png", mimeType: "image/png", base64: "AA==" },
        ],
      }),
    ).toThrow(/requires a provider/);
  });

  it("keeps explicit ACP routing authoritative when images are present", () => {
    const settings = normalizeBackgroundAgentSettings({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });

    expect(
      resolveBackgroundBackendRoute(settings, {
        provider: "acp:claude",
        images: [
          { name: "diagram.png", mimeType: "image/png", base64: "AA==" },
        ],
      }),
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

  it("pins review tasks to a configured review model target", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      reviewTarget: {
        default: { target: "model:custom-claude-opus-4-8", effort: "max" },
      },
      acpAgents: [
        { id: "claude", provider: "anthropic", command: "claude-agent-acp" },
      ],
    });

    // Deterministic even when the foreground shares the model's provider.
    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "anthropic" },
      ),
    ).toEqual({
      backend: "native",
      configuredReviewModel: "custom-claude-opus-4-8",
      configuredReviewEffort: "max",
    });
  });

  it("applies a configured review model target to custom review task classes", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "model:custom-claude-opus-4-8" } },
    });

    expect(
      resolveBackgroundBackendRoute(settings, { taskClass: "review_security" }),
    ).toEqual({
      backend: "native",
      configuredReviewModel: "custom-claude-opus-4-8",
    });
  });

  it("does not apply a review model target to non-review tasks", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "model:custom-claude-opus-4-8" } },
    });

    expect(
      resolveBackgroundBackendRoute(settings, { taskClass: "general" }),
    ).toEqual({ backend: "native" });
  });

  it("lets an explicit request model override a configured review model target", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "model:custom-claude-opus-4-8" } },
    });

    expect(
      resolveBackgroundBackendRoute(settings, {
        model: "gpt-5.6-sol",
        taskClass: "review_code",
      }),
    ).toEqual({ backend: "native" });
  });

  it("uses a native review target instead of the legacy ACP review agent", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewAgent: "acp:claude",
      reviewTarget: { default: { target: "native:auto" } },
      acpAgents: [
        { id: "claude", provider: "anthropic", command: "claude-agent-acp" },
      ],
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "codex" },
      ),
    ).toEqual({ backend: "native" });
  });

  it("carries an effort pinned alongside automatic review routing", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "native:auto", effort: "high" } },
    });

    expect(
      resolveBackgroundBackendRoute(settings, { taskClass: "review_code" }),
    ).toEqual({ backend: "native", configuredReviewEffort: "high" });
  });

  it("routes an ACP review target with the legacy same-provider fall-through", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "acp:claude" } },
      acpAgents: [
        { id: "claude", provider: "anthropic", command: "claude-agent-acp" },
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
    });
    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "anthropic" },
      ),
    ).toEqual({ backend: "native" });
  });

  it("throws for a malformed review target only on review tasks", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "anthropic" } },
    });

    expect(
      resolveBackgroundBackendRoute(settings, { taskClass: "general" }),
    ).toEqual({ backend: "native" });
    expect(() =>
      resolveBackgroundBackendRoute(settings, { taskClass: "review_code" }),
    ).toThrow(/Unsupported agentlink.background.reviewTarget/);
  });

  it("throws for an effort pinned alongside an ACP review target", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: { default: { target: "acp:claude", effort: "high" } },
      acpAgents: [
        { id: "claude", provider: "anthropic", command: "claude-agent-acp" },
      ],
    });

    expect(() =>
      resolveBackgroundBackendRoute(settings, { taskClass: "review_code" }),
    ).toThrow(/control their own reasoning effort/);
  });

  it("selects a review target based on the foreground provider", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: {
        codex: { target: "model:custom-claude-opus-4-8", effort: "max" },
        "openai-compatible:custom-claude": { target: "model:gpt-5.6-sol" },
      },
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "codex" },
      ),
    ).toEqual({
      backend: "native",
      configuredReviewModel: "custom-claude-opus-4-8",
      configuredReviewEffort: "max",
    });
    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "openai-compatible:custom-claude" },
      ),
    ).toEqual({ backend: "native", configuredReviewModel: "gpt-5.6-sol" });
    // Unmapped foreground providers keep automatic cross-provider review.
    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "anthropic" },
      ),
    ).toEqual({ backend: "native" });
  });

  it("routes an unmapped foreground provider through the provider-map default", () => {
    const settings = normalizeBackgroundAgentSettings({
      reviewTarget: {
        codex: { target: "model:custom-claude-opus-4-8" },
        default: { target: "acp:claude" },
      },
      acpAgents: [
        { id: "claude", provider: "anthropic", command: "claude-agent-acp" },
      ],
    });

    expect(
      resolveBackgroundBackendRoute(
        settings,
        { taskClass: "review_code" },
        { foregroundProvider: "openai-compatible:custom-claude" },
      ),
    ).toMatchObject({
      backend: "acp",
      reference: "acp:claude",
      reason: "review_agent",
    });
  });

  it("rejects a model reference supplied as a provider", () => {
    const settings = normalizeBackgroundAgentSettings({});

    expect(() =>
      resolveBackgroundBackendRoute(settings, {
        provider: "model:custom-claude-opus-4-8",
      }),
    ).toThrow(/is not a provider reference/);
  });
});
