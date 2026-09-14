import {
  createWorkspaceMcpToolApproval,
  createWorkspaceMcpTools,
  validateWorkspaceMcpToolApproval,
} from "./mcpTools.js";
import { describe, expect, it, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-mcp-tools-"));
  const projectRoot = path.join(root, "project");
  const globalConfigPath = path.join(root, "global-mcp.json");
  const projectConfigPath = path.join(projectRoot, ".agentlink", "mcp.json");
  const command = path.join(projectRoot, "bin", "server");
  const cwd = path.join(projectRoot, "state");
  await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.mkdir(cwd);
  await fs.writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
  await fs.writeFile(
    globalConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      trustedProjectServerIds: ["local"],
      servers: [
        {
          id: "remote",
          transport: "streamable-http",
          url: "https://mcp.example.test/rpc",
          headers: { Authorization: { credential: "remote-token" } },
          oauth: true,
        },
      ],
    }),
  );
  await fs.writeFile(
    projectConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          id: "local",
          transport: "stdio",
          command,
          args: ["--stdio"],
          cwd,
          env: { API_TOKEN: { credential: "local-token" } },
        },
      ],
    }),
  );
  return {
    root,
    projectRoot,
    globalConfigPath,
    projectConfigPath,
    command,
    cwd,
  };
}

const request = {
  principal: { tenantId: "local", subjectId: "project-a" },
  sessionId: "session-a",
  turnId: "turn-a",
} as const;

describe("workspace MCP composition", () => {
  it("resolves exact credentials and invokes display-safe launch and network callbacks", async () => {
    const test = await fixture();
    const resolveCredential = vi.fn(
      async ({ credential }: { credential: string }) =>
        credential === "local-token"
          ? "local-secret-value"
          : "remote-secret-value",
    );
    const authorizeLaunch = vi.fn(async () => true);
    const authorizeNetwork = vi.fn(async () => true);
    const tools = createWorkspaceMcpTools({
      globalConfigPath: test.globalConfigPath,
      projectRoot: test.projectRoot,
      projectConfigPath: test.projectConfigPath,
      operationDigestSecret: "0123456789abcdef0123456789abcdef",
      resolveCredential,
      authorizeLaunch,
      authorizeNetwork,
    });

    const [stdio] = await tools.resolveStdioServers(request);
    const [remote] = await tools.resolveRemoteServers(request);
    expect(stdio).toEqual({
      id: "local",
      command: test.command,
      args: ["--stdio"],
      cwd: test.cwd,
      env: { API_TOKEN: "local-secret-value" },
    });
    expect(remote).toEqual({
      id: "remote",
      transport: "streamable-http",
      url: "https://mcp.example.test/rpc",
      headers: { Authorization: "remote-secret-value" },
    });
    await expect(
      tools.authorizeStdioLaunch({ ...request, server: stdio! }),
    ).resolves.toBe(true);
    await expect(
      tools.authorizeRemoteNetwork({
        ...request,
        serverId: "remote",
        url: new URL("https://mcp.example.test/rpc?turn=1"),
      }),
    ).resolves.toBe(true);

    expect(authorizeLaunch).toHaveBeenCalledOnce();
    expect(authorizeNetwork).toHaveBeenCalledOnce();
    expect(resolveCredential).toHaveBeenCalledTimes(4);
    const serialized = JSON.stringify({
      launch: authorizeLaunch.mock.lastCall?.[0],
      network: authorizeNetwork.mock.lastCall?.[0],
      snapshot: await tools.snapshot(),
    });
    expect(serialized).not.toContain("local-secret-value");
    expect(serialized).not.toContain("remote-secret-value");
    expect(serialized).toMatch(/local-token/);
    expect(serialized).toMatch(/remote-token/);
    expect(serialized).toMatch(/operationDigest/);

    await fs.rm(test.root, { recursive: true, force: true });
  });

  it("binds exact MCP tool approvals to arguments and current config", async () => {
    const test = await fixture();
    const tools = createWorkspaceMcpTools({
      globalConfigPath: test.globalConfigPath,
      projectRoot: test.projectRoot,
      projectConfigPath: test.projectConfigPath,
      operationDigestSecret: "0123456789abcdef0123456789abcdef",
      resolveCredential: async () => "secret-value",
    });
    const config = await tools.snapshot();
    const approval = createWorkspaceMcpToolApproval(
      "remote__lookup",
      { query: "alpha" },
      config,
      "0123456789abcdef0123456789abcdef",
    );
    expect(approval).toMatchObject({
      kind: "mcp_tool_call",
      serverId: "remote",
      serverToolName: "lookup",
      unsandboxed: true,
    });
    expect(
      validateWorkspaceMcpToolApproval(
        approval!,
        "remote__lookup",
        { query: "alpha" },
        config,
        "0123456789abcdef0123456789abcdef",
      ),
    ).toBe(true);
    expect(
      validateWorkspaceMcpToolApproval(
        approval!,
        "remote__lookup",
        { query: "changed" },
        config,
        "0123456789abcdef0123456789abcdef",
      ),
    ).toBe(false);
    await fs.rm(test.root, { recursive: true, force: true });
  });

  it("defaults launch and network policies to deny", async () => {
    const test = await fixture();
    const tools = createWorkspaceMcpTools({
      globalConfigPath: test.globalConfigPath,
      projectRoot: test.projectRoot,
      projectConfigPath: test.projectConfigPath,
      operationDigestSecret: "0123456789abcdef0123456789abcdef",
      resolveCredential: async ({ credential }) => `${credential}-value`,
    });
    const [stdio] = await tools.resolveStdioServers(request);
    await expect(
      tools.authorizeStdioLaunch({ ...request, server: stdio! }),
    ).resolves.toBe(false);
    await expect(
      tools.authorizeRemoteNetwork({
        ...request,
        serverId: "remote",
        url: new URL("https://mcp.example.test/rpc"),
      }),
    ).resolves.toBe(false);
    await fs.rm(test.root, { recursive: true, force: true });
  });

  it("rejects tampered exact launch values before invoking host policy", async () => {
    const test = await fixture();
    const authorizeLaunch = vi.fn(async () => true);
    const tools = createWorkspaceMcpTools({
      globalConfigPath: test.globalConfigPath,
      projectRoot: test.projectRoot,
      projectConfigPath: test.projectConfigPath,
      operationDigestSecret: "0123456789abcdef0123456789abcdef",
      resolveCredential: async () => "secret-value",
      authorizeLaunch,
    });
    const [stdio] = await tools.resolveStdioServers(request);
    await expect(
      tools.authorizeStdioLaunch({
        ...request,
        server: { ...stdio!, cwd: test.projectRoot },
      }),
    ).resolves.toBe(false);
    expect(authorizeLaunch).not.toHaveBeenCalled();
    await fs.rm(test.root, { recursive: true, force: true });
  });
});
