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

  it("throws for unknown explicit ACP provider", () => {
    const settings = normalizeBackgroundAgentSettings({});

    expect(() =>
      resolveBackgroundBackendRoute(settings, { provider: "acp:missing" }),
    ).toThrow(/Unknown ACP background agent/);
  });
});
