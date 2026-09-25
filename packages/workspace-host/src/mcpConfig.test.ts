import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import { loadWorkspaceMcpConfiguration } from "./mcpConfig.js";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-mcp-config-"),
  );
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const globalConfigPath = path.join(root, "global-mcp.json");
  const projectConfigPath = path.join(projectRoot, ".agentlink", "mcp.json");
  const command = path.join(projectRoot, "bin", "server");
  const cwd = path.join(projectRoot, "server-state");
  await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.mkdir(cwd);
  await fs.writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
  return {
    root,
    projectRoot,
    globalConfigPath,
    projectConfigPath,
    command,
    cwd,
  };
}

async function writeJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("workspace MCP configuration", () => {
  it("gives an untrusted project declaration zero authority", async () => {
    const test = await fixture();
    await writeJson(test.globalConfigPath, {
      schemaVersion: 1,
      trustedProjectServerIds: [],
      servers: [],
    });
    await writeJson(test.projectConfigPath, {
      schemaVersion: 1,
      servers: [
        {
          id: "project_server",
          transport: "stdio",
          command: test.command,
          cwd: test.cwd,
          env: { TOKEN: { credential: "project-token" } },
        },
      ],
    });

    await expect(
      loadWorkspaceMcpConfiguration({
        globalConfigPath: test.globalConfigPath,
        projectRoot: test.projectRoot,
        projectConfigPath: test.projectConfigPath,
      }),
    ).resolves.toMatchObject({ servers: [] });
  });

  it("shadows legacy declarations even when the shared server is disabled", async () => {
    const test = await fixture();
    await writeJson(test.globalConfigPath, {
      schemaVersion: 1,
      trustedProjectServerIds: ["collision"],
      servers: [
        {
          id: "global_collision",
          transport: "streamable-http",
          url: "https://example.test/mcp",
        },
      ],
    });
    await writeJson(test.projectConfigPath, {
      schemaVersion: 1,
      servers: [
        {
          id: "collision",
          transport: "stdio",
          command: test.command,
          cwd: test.cwd,
        },
      ],
    });
    const config = await loadWorkspaceMcpConfiguration({
      globalConfigPath: test.globalConfigPath,
      projectRoot: test.projectRoot,
      projectConfigPath: test.projectConfigPath,
      shadowedLegacyServerIds: new Set(["collision", "global_collision"]),
    });
    expect(config.servers).toEqual([]);
  });

  it("rechecks shadowing on every legacy snapshot", async () => {
    const test = await fixture();
    await writeJson(test.globalConfigPath, {
      schemaVersion: 1,
      trustedProjectServerIds: [],
      servers: [
        {
          id: "collision",
          transport: "streamable-http",
          url: "https://example.test/mcp",
        },
      ],
    });
    let shadow = false;
    const options = {
      globalConfigPath: test.globalConfigPath,
      projectRoot: test.projectRoot,
      shadowedLegacyServerIds: async () => new Set(shadow ? ["collision"] : []),
    };
    expect((await loadWorkspaceMcpConfiguration(options)).servers).toHaveLength(
      1,
    );
    shadow = true;
    expect((await loadWorkspaceMcpConfiguration(options)).servers).toEqual([]);
  });

  it("loads trusted stdio and HTTPS declarations without secret values", async () => {
    const test = await fixture();
    await writeJson(test.globalConfigPath, {
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
    });
    await writeJson(test.projectConfigPath, {
      schemaVersion: 1,
      servers: [
        {
          id: "local",
          transport: "stdio",
          command: test.command,
          args: ["--stdio"],
          cwd: test.cwd,
          env: { API_TOKEN: { credential: "local-token" } },
          timeoutMs: 5_000,
        },
      ],
    });

    const config = await loadWorkspaceMcpConfiguration({
      globalConfigPath: test.globalConfigPath,
      projectRoot: test.projectRoot,
      projectConfigPath: test.projectConfigPath,
    });
    expect(config.servers).toEqual([
      {
        id: "remote",
        source: "global",
        transport: "streamable-http",
        url: "https://mcp.example.test/rpc",
        headers: { Authorization: { credential: "remote-token" } },
        oauth: true,
      },
      {
        id: "local",
        source: "project",
        transport: "stdio",
        command: test.command,
        args: ["--stdio"],
        cwd: test.cwd,
        env: { API_TOKEN: { credential: "local-token" } },
        timeoutMs: 5_000,
      },
    ]);
    expect(JSON.stringify(config)).not.toContain("secret-value");
  });

  it.each([
    {
      name: "unknown properties",
      global: {
        schemaVersion: 1,
        trustedProjectServerIds: [],
        servers: [],
        extra: true,
      },
      error: /unknown property/,
    },
    {
      name: "duplicate ids",
      global: {
        schemaVersion: 1,
        trustedProjectServerIds: [],
        servers: [
          { id: "same", transport: "stdio", command: "/bin/sh", cwd: "/tmp" },
          { id: "same", transport: "stdio", command: "/bin/sh", cwd: "/tmp" },
        ],
      },
      error: /Duplicate/,
    },
    {
      name: "insecure HTTP",
      global: {
        schemaVersion: 1,
        trustedProjectServerIds: [],
        servers: [
          {
            id: "remote",
            transport: "streamable-http",
            url: "http://example.test",
          },
        ],
      },
      error: /credential-free HTTPS/,
    },
    {
      name: "relative executable",
      global: {
        schemaVersion: 1,
        trustedProjectServerIds: [],
        servers: [
          { id: "local", transport: "stdio", command: "server", cwd: "/tmp" },
        ],
      },
      error: /command must be absolute/,
    },
    {
      name: "plaintext environment secret",
      global: {
        schemaVersion: 1,
        trustedProjectServerIds: [],
        servers: [
          {
            id: "local",
            transport: "stdio",
            command: "/bin/sh",
            cwd: "/tmp",
            env: { TOKEN: "plaintext-secret" },
          },
        ],
      },
      error: /TOKEN must be an object/,
    },
  ])("rejects $name", async ({ global, error }) => {
    const test = await fixture();
    await writeJson(test.globalConfigPath, global);
    await expect(
      loadWorkspaceMcpConfiguration({
        globalConfigPath: test.globalConfigPath,
        projectRoot: test.projectRoot,
      }),
    ).rejects.toThrow(error);
  });

  it("rejects project config, executable, and cwd escapes after canonicalization", async () => {
    const test = await fixture();
    const outsideConfig = path.join(test.root, "outside.json");
    const outsideCommand = path.join(test.root, "outside-server");
    const outsideCwd = path.join(test.root, "outside-cwd");
    await fs.writeFile(outsideCommand, "#!/bin/sh\n", { mode: 0o700 });
    await fs.mkdir(outsideCwd);
    await writeJson(test.globalConfigPath, {
      schemaVersion: 1,
      trustedProjectServerIds: ["local"],
      servers: [],
    });
    await writeJson(outsideConfig, { schemaVersion: 1, servers: [] });
    await expect(
      loadWorkspaceMcpConfiguration({
        globalConfigPath: test.globalConfigPath,
        projectRoot: test.projectRoot,
        projectConfigPath: outsideConfig,
      }),
    ).rejects.toThrow(/escapes/);

    for (const [command, cwd] of [
      [outsideCommand, test.cwd],
      [test.command, outsideCwd],
    ]) {
      await writeJson(test.projectConfigPath, {
        schemaVersion: 1,
        servers: [{ id: "local", transport: "stdio", command, cwd }],
      });
      await expect(
        loadWorkspaceMcpConfiguration({
          globalConfigPath: test.globalConfigPath,
          projectRoot: test.projectRoot,
          projectConfigPath: test.projectConfigPath,
        }),
      ).rejects.toThrow(/escapes/);
    }
  });
});
