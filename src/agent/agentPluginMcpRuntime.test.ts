import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AgentPluginCatalogMcpServer,
  AgentPluginCatalogProvider,
  AgentPluginCatalogSnapshot,
} from "./AgentPluginCatalog.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentPluginMcpRuntimeServerName,
  authorizeAgentPluginMcpTool,
  buildAgentPluginStdioEnvironment,
  isAgentPluginMcpConfigCurrent,
  loadAgentPluginMcpConfigs,
  loadAgentPluginStdioMcpConfigs,
} from "./agentPluginMcpRuntime.js";

import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";

function projectScope(
  projectId: string,
  rootPath: string,
): SessionProjectScope {
  return {
    schemaVersion: 1,
    kind: "project",
    projectId,
    workspaceFolderUri: `file://${rootPath}`,
    displayName: projectId,
    rootPath,
  };
}

function snapshot(
  scope: Readonly<SessionProjectScope>,
  mcpServers: readonly AgentPluginCatalogMcpServer[],
): AgentPluginCatalogSnapshot {
  return {
    schemaVersion: 1,
    registryRevision: 7,
    projectId: scope.projectId,
    workspaceFolderUri: scope.workspaceFolderUri,
    selectedDigests: {},
    installs: [],
    skills: [],
    mcpServers,
    diagnostics: [],
  };
}

function catalog(
  getSnapshot: AgentPluginCatalogProvider["getSnapshot"],
): AgentPluginCatalogProvider {
  return {
    getSnapshot,
    subscribe: () => ({ dispose() {} }),
  };
}

describe("agentPluginMcpRuntime", () => {
  let directory: string;
  let pluginRoot: string;
  let pluginData: string;
  let scope: SessionProjectScope;

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugin-mcp-")),
    );
    pluginRoot = path.join(directory, "package");
    pluginData = path.join(directory, "data");
    scope = projectScope("project-a", path.join(directory, "workspace-a"));
    await fs.mkdir(path.join(pluginRoot, "bin"), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "bin", "server.js"), "");
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function entry(
    overrides: Partial<AgentPluginCatalogMcpServer> = {},
  ): AgentPluginCatalogMcpServer {
    return {
      installInstanceId: "install-a",
      packageDigest: "a".repeat(64),
      manifestName: "fixture-plugin",
      portableServerName: "tools",
      server: {
        type: "stdio",
        command: "./bin/server.js",
        args: ["${PLUGIN_ROOT}/fixture.json", "${PLUGIN_DATA}/state.json"],
        env: { FIXTURE_ROOT: "${PLUGIN_ROOT}", FIXTURE_DATA: "${PLUGIN_DATA}" },
        cwd: "${PLUGIN_DATA}/runtime",
      },
      scope: {
        kind: "project",
        projectId: scope.projectId,
        workspaceFolderUri: scope.workspaceFolderUri,
      },
      pluginRoot,
      pluginData,
      policy: { allowedTools: ["read"] },
      ...overrides,
    };
  }

  it("projects a stable qualified stdio config with bounded roots and provenance", async () => {
    const getSnapshot = vi.fn(async () => snapshot(scope, [entry()]));

    const configs = await loadAgentPluginStdioMcpConfigs({
      requestingScope: scope,
      pluginCatalog: catalog(getSnapshot),
      platform: "darwin",
    });

    expect(getSnapshot).toHaveBeenCalledWith(scope);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      name: "plugin-install-a-tools",
      command: path.join(pluginRoot, "bin", "server.js"),
      args: [
        path.join(pluginRoot, "fixture.json"),
        path.join(pluginData, "state.json"),
      ],
      env: { FIXTURE_ROOT: pluginRoot, FIXTURE_DATA: pluginData },
      cwd: path.join(pluginData, "runtime"),
      pluginRoot,
      pluginData,
      toolPolicy: "ask",
      allowedTools: ["read"],
      provenance: {
        kind: "agent-plugin",
        scope: { kind: "project", projectId: "project-a" },
        installInstanceId: "install-a",
        packageDigest: "a".repeat(64),
        portableServerName: "tools",
        runtimeServerName: "plugin-install-a-tools",
      },
    });
    await expect(fs.stat(pluginData)).resolves.toBeDefined();
  });

  it("projects declared HTTP transports without stdio-only roots or expansion", async () => {
    const configuredHeaders = {
      Authorization: "package-token",
      "X-Plugin-Root": "${PLUGIN_ROOT}",
    };
    const getSnapshot = vi.fn(async () =>
      snapshot(scope, [
        entry({
          portableServerName: "http-tools",
          server: {
            type: "streamable-http",
            url: "https://mcp.example.test/${PLUGIN_ROOT}",
            headers: configuredHeaders,
          },
        }),
        entry({
          installInstanceId: "install-sse",
          portableServerName: "events",
          server: {
            type: "sse",
            url: "http://localhost:9123/events",
            headers: { "X-Plugin": "fixture" },
          },
        }),
      ]),
    );

    const configs = await loadAgentPluginMcpConfigs({
      requestingScope: scope,
      pluginCatalog: catalog(getSnapshot),
      platform: "darwin",
    });

    expect(configs).toEqual([
      expect.objectContaining({
        name: "plugin-install-a-http-tools",
        type: "streamable-http",
        url: "https://mcp.example.test/${PLUGIN_ROOT}",
        headers: configuredHeaders,
      }),
      expect.objectContaining({
        name: "plugin-install-sse-events",
        type: "sse",
        url: "http://localhost:9123/events",
        headers: { "X-Plugin": "fixture" },
      }),
    ]);
    expect(configs[0]).not.toHaveProperty("pluginRoot");
    expect(configs[0]).not.toHaveProperty("pluginData");
    expect(configs[1]).not.toHaveProperty("pluginRoot");
    expect(configs[1]).not.toHaveProperty("pluginData");
    expect(configs[0]?.headers).not.toBe(configuredHeaders);
    await expect(
      isAgentPluginMcpConfigCurrent(configs[0]!, {
        requestingScope: scope,
        pluginCatalog: catalog(getSnapshot),
        platform: "darwin",
      }),
    ).resolves.toBe(true);
    await expect(
      isAgentPluginMcpConfigCurrent(
        { ...configs[0]!, url: "https://other.example.test/mcp" },
        {
          requestingScope: scope,
          pluginCatalog: catalog(getSnapshot),
          platform: "darwin",
        },
      ),
    ).resolves.toBe(false);
  });

  it("uses the requesting project catalog without leaking another project's servers", async () => {
    const otherScope = projectScope(
      "project-b",
      path.join(directory, "workspace-b"),
    );
    const globalEntry = entry({ scope: { kind: "global" } });
    const projectEntry = entry({
      installInstanceId: "install-project-a",
      portableServerName: "project-tools",
    });
    const getSnapshot = vi.fn(async (requestingScope: SessionProjectScope) =>
      requestingScope.projectId === scope.projectId
        ? snapshot(scope, [globalEntry, projectEntry])
        : snapshot(otherScope, [globalEntry]),
    );
    const provider = catalog(getSnapshot);

    const projectA = await loadAgentPluginStdioMcpConfigs({
      requestingScope: scope,
      pluginCatalog: provider,
      platform: "darwin",
    });
    const projectB = await loadAgentPluginStdioMcpConfigs({
      requestingScope: otherScope,
      pluginCatalog: provider,
      platform: "darwin",
    });

    expect(projectA.map((config) => config.name)).toEqual([
      "plugin-install-a-tools",
      "plugin-install-project-a-project-tools",
    ]);
    expect(projectB.map((config) => config.name)).toEqual([
      "plugin-install-a-tools",
    ]);
  });

  it("fails closed when command or cwd escapes the package/data roots", async () => {
    await expect(
      loadAgentPluginStdioMcpConfigs({
        requestingScope: scope,
        pluginCatalog: catalog(async () =>
          snapshot(scope, [
            entry({
              server: { type: "stdio", command: "./../outside.js" },
            }),
          ]),
        ),
        platform: "darwin",
      }),
    ).rejects.toThrow("command failed containment validation");

    await expect(
      loadAgentPluginStdioMcpConfigs({
        requestingScope: scope,
        pluginCatalog: catalog(async () =>
          snapshot(scope, [
            entry({
              server: {
                type: "stdio",
                command: "node",
                cwd: "${PLUGIN_ROOT}/../outside",
              },
            }),
          ]),
        ),
        platform: "darwin",
      }),
    ).rejects.toThrow("working directory failed containment validation");
  });

  it("builds a client-controlled environment and rejects reserved/case collisions", () => {
    expect(
      buildAgentPluginStdioEnvironment(
        { PATH: "/bin" },
        { FIXTURE: "yes" },
        { pluginRoot, pluginData },
        "darwin",
      ),
    ).toEqual({
      PATH: "/bin",
      FIXTURE: "yes",
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: pluginData,
    });
    expect(() =>
      buildAgentPluginStdioEnvironment(
        {},
        { PLUGIN_ROOT: "spoofed" },
        { pluginRoot, pluginData },
        "darwin",
      ),
    ).toThrow("client-controlled variable");
    expect(() =>
      buildAgentPluginStdioEnvironment(
        { Path: "/bin" },
        { PATH: "/other" },
        { pluginRoot, pluginData },
        "win32",
      ),
    ).toThrow("collides with 'Path'");
  });

  it("invalidates changed catalog authority and enforces plugin tool policy", async () => {
    const [config] = await loadAgentPluginStdioMcpConfigs({
      requestingScope: scope,
      pluginCatalog: catalog(async () => snapshot(scope, [entry()])),
      platform: "darwin",
    });

    expect(
      await isAgentPluginMcpConfigCurrent(config!, {
        requestingScope: scope,
        pluginCatalog: catalog(async () => snapshot(scope, [entry()])),
        platform: "darwin",
      }),
    ).toBe(true);
    expect(
      await isAgentPluginMcpConfigCurrent(config!, {
        requestingScope: scope,
        pluginCatalog: catalog(async () =>
          snapshot(scope, [entry({ packageDigest: "b".repeat(64) })]),
        ),
        platform: "darwin",
      }),
    ).toBe(false);
    expect(
      await isAgentPluginMcpConfigCurrent(
        { ...config!, provenance: undefined },
        {
          requestingScope: scope,
          pluginCatalog: catalog(async () => snapshot(scope, [entry()])),
          platform: "darwin",
        },
      ),
    ).toBe(false);

    expect(
      authorizeAgentPluginMcpTool({
        bareToolName: "read",
        config: config!,
        approved: false,
      }),
    ).toBe("allow");
    expect(
      authorizeAgentPluginMcpTool({
        bareToolName: "write",
        config: config!,
        approved: false,
      }),
    ).toBe("deny");
    expect(
      authorizeAgentPluginMcpTool({
        bareToolName: "write",
        config: config!,
        approved: true,
      }),
    ).toBe("allow");
    expect(
      authorizeAgentPluginMcpTool({
        bareToolName: "read",
        config: { ...config!, disabled: true },
        approved: true,
      }),
    ).toBe("deny");
    expect(
      authorizeAgentPluginMcpTool({
        bareToolName: "write",
        config: { ...config!, toolPolicy: "allow" },
        approved: false,
      }),
    ).toBe("allow");
    expect(
      authorizeAgentPluginMcpTool({
        bareToolName: "read",
        config: { ...config!, provenance: undefined },
        approved: true,
      }),
    ).toBe("deny");
  });

  it("keeps long runtime names stable, bounded, and collision-safe", () => {
    const first = agentPluginMcpRuntimeServerName("x".repeat(80), "tools");
    const second = agentPluginMcpRuntimeServerName("x".repeat(80), "other");
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(first).not.toBe(second);
    expect(agentPluginMcpRuntimeServerName("install", "a__b")).not.toContain(
      "__",
    );
  });
});
