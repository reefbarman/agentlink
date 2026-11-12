import { afterEach, describe, expect, it } from "vitest";
import {
  askAgentMcpConfigSources,
  globalMcpConfigSources,
  loadMcpConfigsFromSources,
  projectMcpConfigSources,
  readMcpConfig,
  resolveMcpServerCwd,
} from "./mcpConfig.js";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function source(root: string, directory: string, config: unknown) {
  const target = path.join(root, directory, "mcp.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(config));
  return target;
}

describe("shared MCP config", () => {
  it("reads the same global, project and projectless source precedence", async () => {
    const home = path.join(os.tmpdir(), "mcp-home");
    const project = path.join(os.tmpdir(), "mcp-project");
    expect(globalMcpConfigSources(home)).toEqual(
      [".agents", ".claude", ".agentlink"].map((directory) =>
        path.join(home, directory, "mcp.json"),
      ),
    );
    expect(projectMcpConfigSources(project).at(-1)).toBe(
      path.join(project, ".agentlink", "mcp.json"),
    );
    expect(askAgentMcpConfigSources(home).at(-1)).toBe(
      path.join(home, ".agentlink", "ask-agent", "mcp.json"),
    );
  });

  it("merges patches and interpolates environment values without duplicating a source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shared-"));
    roots.push(root);
    const global = await source(root, "global", {
      mcpServers: {
        records: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "${TOKEN}" },
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      },
    });
    const project = await source(root, "project", {
      mcpServers: {
        records: { allowedTools: ["lookup"], toolDisclosure: "deferred" },
      },
    });
    expect(
      await loadMcpConfigsFromSources([global, project, global], {
        TOKEN: "secret",
      }),
    ).toEqual([
      expect.objectContaining({
        name: "records",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret" },
        headers: { Authorization: "Bearer secret" },
        toolDisclosure: "deferred",
        allowedTools: ["lookup"],
      }),
    ]);
    expect(await readMcpConfig(project)).toMatchObject({ status: "available" });
    expect(
      await loadMcpConfigsFromSources(
        [global, project],
        { TOKEN: "secret" },
        { root, sources: [project] },
      ),
    ).toEqual([
      expect.objectContaining({
        name: "records",
        sourceProjectRoots: [root],
        provenance: expect.objectContaining({ kind: "native" }),
      }),
    ]);
  });

  it("resolves a relative stdio cwd against the config's owning folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shared-"));
    roots.push(root);
    const file = await source(root, ".agentlink", {
      mcpServers: {
        relative: { command: "bash", args: ["drawthings.sh"], cwd: "scripts" },
        dot: { command: "node", cwd: "." },
        absolute: { command: "node", cwd: "/opt/mcp" },
        home: { command: "node", cwd: "~/mcp" },
        unset: { command: "node" },
      },
    });
    const configs = await loadMcpConfigsFromSources(
      [file],
      {},
      {
        root,
        sources: [file],
      },
    );
    expect(
      Object.fromEntries(configs.map((cfg) => [cfg.name, cfg.cwd])),
    ).toEqual({
      relative: path.join(root, "scripts"),
      dot: root,
      absolute: "/opt/mcp",
      home: path.join(os.homedir(), "mcp"),
      unset: undefined,
    });
    expect(resolveMcpServerCwd("~", file, "/home/u")).toBe("/home/u");
    // Ask Agent's config lives one level deeper but still belongs to home.
    expect(
      resolveMcpServerCwd(
        "tools",
        "/home/u/.agentlink/ask-agent/mcp.json",
        "/home/u",
      ),
    ).toBe("/home/u/tools");
  });

  it("reads the per-server protocol override", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shared-"));
    roots.push(root);
    const file = await source(root, "global", {
      mcpServers: {
        pinned: { command: "node", protocol: "2026-07-28" },
        old: { command: "node", protocol: "legacy" },
        unknown: { command: "node", protocol: "2025-11-25" },
        unset: { command: "node" },
      },
    });
    const configs = await loadMcpConfigsFromSources([file], {});
    expect(
      Object.fromEntries(configs.map((cfg) => [cfg.name, cfg.protocol])),
    ).toEqual({
      pinned: "2026-07-28",
      old: "legacy",
      unknown: "auto",
      unset: undefined,
    });
    // Unset stays absent so existing configs compare equal across reloads.
    expect("protocol" in JSON.parse(JSON.stringify(configs[3]))).toBe(false);
  });

  it("does not classify home-as-project sources as project authority", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shared-"));
    roots.push(home);
    const global = await source(home, ".agentlink", {
      mcpServers: { records: { command: "node" } },
    });
    const project = path.join(home, ".agentlink", "mcp.json");
    expect(
      await loadMcpConfigsFromSources(
        [global, project],
        {},
        { root: home, sources: [project] },
      ),
    ).toEqual([expect.objectContaining({ name: "records" })]);
    expect(
      (
        await loadMcpConfigsFromSources(
          [global, project],
          {},
          { root: home, sources: [project] },
        )
      )[0]?.sourceProjectRoots,
    ).toBeUndefined();
  });
});
