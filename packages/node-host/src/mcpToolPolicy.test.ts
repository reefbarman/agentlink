import { describe, expect, it } from "vitest";

import type { McpServerConfig } from "./mcpConfig.js";
import { authorizeMcpToolCall } from "./mcpToolPolicy.js";

const plugin: McpServerConfig = {
  name: "plugin-example",
  provenance: {
    kind: "agent-plugin",
    scope: { kind: "global" },
    installInstanceId: "install",
    packageDigest: "digest",
    portableServerName: "example",
    runtimeServerName: "plugin-example",
  },
};

describe("authorizeMcpToolCall", () => {
  it("retains native policy and denies forged plugin boundaries", () => {
    expect(
      authorizeMcpToolCall({
        config: { name: "native" },
        bareToolName: "read",
        approved: false,
      }),
    ).toBe("deny");
    expect(
      authorizeMcpToolCall({
        config: { name: "native", toolPolicy: "allow" },
        bareToolName: "read",
        approved: false,
      }),
    ).toBe("allow");
    expect(
      authorizeMcpToolCall({
        config: { name: "native", allowedTools: ["read"] },
        bareToolName: "read",
        approved: false,
      }),
    ).toBe("allow");
    expect(
      authorizeMcpToolCall({
        config: { name: "native", disabled: true, toolPolicy: "allow" },
        bareToolName: "read",
        approved: true,
      }),
    ).toBe("deny");
    expect(
      authorizeMcpToolCall({
        config: { name: "native", pluginRoot: "/plugin" },
        bareToolName: "read",
        approved: true,
      }),
    ).toBe("deny");
  });

  it("enforces disabled, allow, allowlist and caller approval for plugins", () => {
    const decide = (config: McpServerConfig, approved = false) =>
      authorizeMcpToolCall({ config, bareToolName: "read", approved });
    expect(decide({ ...plugin, disabled: true, toolPolicy: "allow" })).toBe(
      "deny",
    );
    expect(decide({ ...plugin, toolPolicy: "allow" })).toBe("allow");
    expect(decide({ ...plugin, allowedTools: ["read"] })).toBe("allow");
    expect(decide(plugin)).toBe("deny");
    expect(decide(plugin, true)).toBe("allow");
  });
});
