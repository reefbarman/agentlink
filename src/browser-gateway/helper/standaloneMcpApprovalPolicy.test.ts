/** @vitest-environment node */

import * as fs from "node:fs/promises";
import * as mcpConfig from "../../agent/mcpConfig.js";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistStandaloneMcpGlobalApproval } from "./standaloneMcpApprovalPolicy.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

describe("Desktop shared Global MCP approvals", () => {
  let home: string;
  let sharedPath: string;
  let desktopPath: string;
  const request = {
    serverName: "local",
    bareToolName: "search",
    target: "tool" as const,
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "agentlink-mcp-approval-"));
    vi.stubEnv("HOME", home);
    sharedPath = path.join(home, ".agentlink", "mcp.json");
    desktopPath = path.join(home, ".agentlink", "ask-agent", "mcp.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("rejects Desktop-only servers without creating a shared stub entry", async () => {
    await writeJson(desktopPath, {
      mcpServers: { local: { command: "node" } },
    });
    const original = await fs.readFile(desktopPath, "utf-8");

    await expect(persistStandaloneMcpGlobalApproval(request)).rejects.toThrow(
      "mcp_global_approval_server_not_shared",
    );
    await expect(fs.stat(sharedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(desktopPath, "utf-8")).toBe(original);
  });

  it("accepts inherited shared connections without creating a Desktop override", async () => {
    await writeJson(path.join(home, ".agents", "mcp.json"), {
      mcpServers: { local: { command: "node" } },
    });

    await persistStandaloneMcpGlobalApproval(request);

    expect(await mcpConfig.loadMcpConfigs(home)).toMatchObject([
      { name: "local", command: "node", allowedTools: ["search"] },
    ]);
    expect(await mcpConfig.loadAskAgentMcpConfigs()).toMatchObject([
      { name: "local", command: "node", allowedTools: ["search"] },
    ]);
    await expect(fs.stat(desktopPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["tool", "server"] as const)(
    "mirrors a %s rule when a Desktop override would hide the shared approval",
    async (target) => {
      await writeJson(sharedPath, {
        mcpServers: { local: { command: "node", allowedTools: ["existing"] } },
      });
      await writeJson(desktopPath, {
        mcpServers: {
          local: {
            toolPolicy: "ask",
            allowedTools: ["desktop"],
            env: { KEEP: "value" },
          },
        },
      });

      await persistStandaloneMcpGlobalApproval({ ...request, target });

      const expected =
        target === "server"
          ? { toolPolicy: "allow" }
          : { allowedTools: ["desktop", "search"] };
      expect(await mcpConfig.loadAskAgentMcpConfigs()).toMatchObject([
        { name: "local", command: "node", ...expected, env: { KEEP: "value" } },
      ]);
      expect(await mcpConfig.loadMcpConfigs(home)).toMatchObject([
        {
          name: "local",
          ...(target === "server"
            ? { toolPolicy: "allow" }
            : { allowedTools: ["existing", "search"] }),
        },
      ]);
    },
  );

  it.each(["tool", "server"] as const)(
    "does not rewrite a Desktop override already allowing the %s",
    async (target) => {
      await writeJson(sharedPath, {
        mcpServers: { local: { command: "node" } },
      });
      await writeJson(desktopPath, {
        mcpServers: {
          local: { toolPolicy: "allow", allowedTools: ["search"] },
        },
      });
      const original = await fs.readFile(desktopPath, "utf-8");

      await persistStandaloneMcpGlobalApproval({ ...request, target });

      expect(await fs.readFile(desktopPath, "utf-8")).toBe(original);
    },
  );

  it.each(["invalid", "unreadable"])(
    "fails closed without overwriting an %s shared configuration",
    async (status) => {
      await fs.mkdir(path.dirname(sharedPath), { recursive: true });
      if (status === "invalid")
        await fs.writeFile(sharedPath, "{broken", "utf-8");
      else await fs.mkdir(sharedPath);

      await expect(persistStandaloneMcpGlobalApproval(request)).rejects.toThrow(
        "mcp_approval_save_failed",
      );
      if (status === "invalid")
        expect(await fs.readFile(sharedPath, "utf-8")).toBe("{broken");
      else expect((await fs.stat(sharedPath)).isDirectory()).toBe(true);
    },
  );

  it("leaves shared rules untouched when the Desktop override is invalid", async () => {
    await writeJson(sharedPath, { mcpServers: { local: { command: "node" } } });
    await fs.mkdir(path.dirname(desktopPath), { recursive: true });
    await fs.writeFile(desktopPath, "{broken", "utf-8");
    const original = await fs.readFile(sharedPath, "utf-8");

    await expect(persistStandaloneMcpGlobalApproval(request)).rejects.toThrow(
      "mcp_approval_save_failed",
    );

    expect(await fs.readFile(sharedPath, "utf-8")).toBe(original);
  });

  it("reports a Desktop override save failure after the shared rule is saved", async () => {
    await writeJson(sharedPath, { mcpServers: { local: { command: "node" } } });
    await writeJson(desktopPath, {
      mcpServers: { local: { allowedTools: [] } },
    });
    const persist = mcpConfig.persistMcpToolApproval;
    vi.spyOn(mcpConfig, "persistMcpToolApproval").mockImplementation(
      async (server, tool, filePath) => {
        if (filePath === desktopPath) throw new Error("write failed");
        await persist(server, tool, filePath);
      },
    );

    await expect(persistStandaloneMcpGlobalApproval(request)).rejects.toThrow(
      "mcp_global_approval_desktop_override_save_failed",
    );
    expect(await mcpConfig.loadMcpConfigs(home)).toMatchObject([
      { name: "local", allowedTools: ["search"] },
    ]);
    expect(await mcpConfig.loadAskAgentMcpConfigs()).toMatchObject([
      { name: "local", allowedTools: [] },
    ]);
  });
});
