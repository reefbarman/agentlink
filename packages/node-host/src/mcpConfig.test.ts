import { afterEach, describe, expect, it } from "vitest";
import {
  askAgentMcpConfigSources,
  globalMcpConfigSources,
  loadMcpConfigsFromSources,
  projectMcpConfigSources,
  readMcpConfig,
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
