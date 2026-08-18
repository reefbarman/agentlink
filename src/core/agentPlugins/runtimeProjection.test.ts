import { describe, expect, it } from "vitest";

import { projectAgentPluginMcpRuntimeEntry } from "./runtimeProjection.js";

describe("projectAgentPluginMcpRuntimeEntry", () => {
  it("expands stdio runtime values without changing command or env keys", () => {
    expect(
      projectAgentPluginMcpRuntimeEntry({
        serverName: "local",
        pluginRoot: "/plugins/example",
        pluginData: "/data/example",
        server: {
          type: "stdio",
          command: "./${PLUGIN_ROOT}/server",
          args: ["${PLUGIN_ROOT}/config", "${PLUGIN_DATA}/state"],
          env: { "${PLUGIN_ROOT}": "${PLUGIN_DATA}/cache" },
        },
      }),
    ).toEqual({
      serverName: "local",
      pluginRoot: "/plugins/example",
      pluginData: "/data/example",
      server: {
        type: "stdio",
        command: "./${PLUGIN_ROOT}/server",
        args: ["/plugins/example/config", "/data/example/state"],
        env: { "${PLUGIN_ROOT}": "/data/example/cache" },
        cwd: "/plugins/example",
      },
    });
  });

  it("leaves HTTP entries unchanged", () => {
    const server = {
      type: "streamable-http" as const,
      url: "https://example.com/${PLUGIN_ROOT}",
      headers: { "X-Path": "${PLUGIN_DATA}" },
    };
    expect(
      projectAgentPluginMcpRuntimeEntry({
        serverName: "remote",
        server,
        pluginRoot: "/plugins/example",
        pluginData: "/data/example",
      }).server,
    ).toBe(server);
  });
});
