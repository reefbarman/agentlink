import {
  cliMcpGlobalConfigPath,
  cliMcpProjectConfigPath,
  ensureCliMcpGlobalConfig,
  loadCliMcpConfiguration,
  trustCliProjectMcpServer,
} from "./mcpConfig.js";
import { describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("CLI MCP configuration", () => {
  it("creates private empty host config and gives project declarations zero authority", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mcp-config-"));
    const dataRoot = path.join(parent, "data");
    const projectRoot = path.join(parent, "project");
    await fs.mkdir(path.join(projectRoot, ".agentlink"), { recursive: true });
    await fs.writeFile(
      cliMcpProjectConfigPath(projectRoot),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "records",
            transport: "streamable-http",
            url: "https://mcp.example.test/rpc",
            headers: {
              Authorization: { credential: "records-token" },
            },
          },
        ],
      }),
    );
    try {
      const configPath = await ensureCliMcpGlobalConfig(dataRoot);
      expect(configPath).toBe(cliMcpGlobalConfigPath(dataRoot));
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      await expect(
        loadCliMcpConfiguration(dataRoot, projectRoot),
      ).resolves.toMatchObject({ servers: [] });

      await trustCliProjectMcpServer(dataRoot, "records");
      const trusted = await loadCliMcpConfiguration(dataRoot, projectRoot);
      expect(trusted.servers).toEqual([
        expect.objectContaining({
          id: "records",
          source: "project",
          headers: {
            Authorization: { credential: "records-token" },
          },
        }),
      ]);
      expect(JSON.stringify(trusted)).not.toContain("secret-value");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects invalid server IDs before modifying trust", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mcp-config-"));
    try {
      await expect(trustCliProjectMcpServer(parent, "bad id")).rejects.toThrow(
        "MCP server ID is invalid",
      );
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
