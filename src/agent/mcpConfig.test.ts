import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpConfigEntries,
  getMcpConfigSources,
  loadAskAgentMcpConfigs,
  loadMcpConfigs,
  removeMcpConfigServer,
  upsertMcpConfigServer,
} from "./mcpConfig.js";
import { dirname, join } from "path";
import { mkdir, readFile, rm, writeFile } from "fs/promises";

import { randomUUID } from "crypto";
import { tmpdir } from "os";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("loadMcpConfigs", () => {
  let root: string;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    root = join(tmpdir(), `agentlink-mcp-config-${randomUUID()}`);
    home = join(root, "home");
    cwd = join(root, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    homedirMock.mockReturnValue(home);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("defaults toolDisclosure to auto", async () => {
    await writeJson(join(cwd, ".agentlink", "mcp.json"), {
      mcpServers: {
        linear: {
          command: "linear-mcp",
        },
      },
    });

    expect(await loadMcpConfigs(cwd)).toMatchObject([
      {
        name: "linear",
        command: "linear-mcp",
        toolPolicy: "ask",
        toolDisclosure: "auto",
      },
    ]);
  });

  it("loads mcp configs with json comments and trailing commas", async () => {
    await mkdir(join(cwd, ".agentlink"), { recursive: true });
    await writeFile(
      join(cwd, ".agentlink", "mcp.json"),
      `{
        // Local MCP server for development.
        "mcpServers": {
          "linear": {
            "command": "linear-mcp",
            "args": [
              "--stdio",
            ],
          },
        },
      }
`,
      "utf-8",
    );

    expect(await loadMcpConfigs(cwd)).toMatchObject([
      {
        name: "linear",
        command: "linear-mcp",
        args: ["--stdio"],
      },
    ]);
  });

  it("merges toolDisclosure from higher-priority config patches", async () => {
    await writeJson(join(home, ".agentlink", "mcp.json"), {
      mcpServers: {
        notion: {
          command: "notion-mcp",
          toolDisclosure: "inline",
        },
      },
    });
    await writeJson(join(cwd, ".agentlink", "mcp.json"), {
      mcpServers: {
        notion: {
          toolDisclosure: "deferred",
        },
      },
    });

    expect(await loadMcpConfigs(cwd)).toMatchObject([
      {
        name: "notion",
        command: "notion-mcp",
        toolDisclosure: "deferred",
      },
    ]);
  });

  it("preserves lower-priority toolDisclosure when higher-priority patches other fields", async () => {
    await writeJson(join(home, ".agentlink", "mcp.json"), {
      mcpServers: {
        linear: {
          command: "linear-mcp",
          toolDisclosure: "inline",
        },
      },
    });
    await writeJson(join(cwd, ".agentlink", "mcp.json"), {
      mcpServers: {
        linear: {
          toolPolicy: "allow",
        },
      },
    });

    expect(await loadMcpConfigs(cwd)).toMatchObject([
      {
        name: "linear",
        toolPolicy: "allow",
        toolDisclosure: "inline",
      },
    ]);
  });

  it("sanitizes invalid toolDisclosure values to auto", async () => {
    await writeJson(join(cwd, ".agentlink", "mcp.json"), {
      mcpServers: {
        bad: {
          command: "bad-mcp",
          toolDisclosure: "sometimes",
        },
      },
    });

    expect(await loadMcpConfigs(cwd)).toMatchObject([
      {
        name: "bad",
        toolDisclosure: "auto",
      },
    ]);
  });

  it("does not load Ask Agent-specific config into the main MCP profile", async () => {
    await writeJson(join(home, ".agentlink", "ask-agent", "mcp.json"), {
      mcpServers: {
        browserOnly: {
          command: "browser-only-mcp",
        },
      },
    });

    expect(await loadMcpConfigs(cwd)).toEqual([]);
  });

  it("loads Ask Agent MCP configs from global sources plus Ask Agent overrides", async () => {
    await writeJson(join(home, ".agentlink", "mcp.json"), {
      mcpServers: {
        shared: {
          command: "shared-mcp",
          toolDisclosure: "inline",
        },
      },
    });
    await writeJson(join(home, ".agentlink", "ask-agent", "mcp.json"), {
      mcpServers: {
        shared: {
          toolPolicy: "allow",
        },
        browserOnly: {
          command: "browser-only-mcp",
        },
      },
    });

    expect(await loadAskAgentMcpConfigs()).toMatchObject([
      {
        name: "shared",
        command: "shared-mcp",
        toolPolicy: "allow",
        toolDisclosure: "inline",
      },
      {
        name: "browserOnly",
        command: "browser-only-mcp",
        toolPolicy: "ask",
        toolDisclosure: "auto",
      },
    ]);
  });

  it("does not load project MCP configs into the Ask Agent MCP profile", async () => {
    await writeJson(join(cwd, ".agentlink", "mcp.json"), {
      mcpServers: {
        projectOnly: {
          command: "project-only-mcp",
        },
      },
    });
    await writeJson(join(home, ".agentlink", "ask-agent", "mcp.json"), {
      mcpServers: {
        browserOnly: {
          command: "browser-only-mcp",
        },
      },
    });

    expect(await loadAskAgentMcpConfigs()).toMatchObject([
      {
        name: "browserOnly",
        command: "browser-only-mcp",
      },
    ]);
  });

  it("builds redacted Ask Agent config entries and source summaries", async () => {
    await writeJson(join(home, ".agentlink", "mcp.json"), {
      mcpServers: {
        shared: {
          type: "sse",
          url: "https://example.com/sse",
          headers: { Authorization: "Bearer secret" },
        },
      },
    });
    await writeJson(join(home, ".agentlink", "ask-agent", "mcp.json"), {
      mcpServers: {
        shared: {
          toolPolicy: "allow",
        },
      },
    });

    const sources = await getMcpConfigSources("ask-agent");
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "ask-agent-global", editable: true }),
        expect.objectContaining({ label: "Global AgentLink", editable: false }),
      ]),
    );

    expect(await buildMcpConfigEntries("ask-agent")).toMatchObject([
      {
        name: "shared",
        config: {
          type: "sse",
          url: "https://example.com/sse",
          toolPolicy: "allow",
        },
        inherited: true,
        hasSecrets: true,
        editableScopes: ["ask-agent-global"],
      },
    ]);
  });

  it("preserves existing env and headers when structured edits omit secrets", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, {
      mcpServers: {
        remote: {
          type: "sse",
          url: "https://old.example.com/sse",
          env: { API_TOKEN: "secret-token" },
          headers: { Authorization: "Bearer secret" },
        },
      },
    });

    await upsertMcpConfigServer({
      profile: "ask-agent",
      scope: "ask-agent-global",
      server: {
        name: "remote",
        type: "sse",
        url: "https://new.example.com/sse",
        toolPolicy: "allow",
      },
    });

    const written = JSON.parse(await readFile(configPath, "utf-8"));
    expect(written.mcpServers.remote).toEqual({
      type: "sse",
      url: "https://new.example.com/sse",
      env: { API_TOKEN: "secret-token" },
      headers: { Authorization: "Bearer secret" },
      toolPolicy: "allow",
    });
  });

  it("writes and removes Ask Agent MCP servers only in the Ask Agent config", async () => {
    await upsertMcpConfigServer({
      profile: "ask-agent",
      scope: "ask-agent-global",
      server: {
        name: "browserOnly",
        command: "browser-mcp",
        args: ["--stdio"],
        toolDisclosure: "deferred",
      },
    });

    expect(await loadAskAgentMcpConfigs()).toMatchObject([
      {
        name: "browserOnly",
        command: "browser-mcp",
        args: ["--stdio"],
        toolDisclosure: "deferred",
      },
    ]);
    expect(await loadMcpConfigs(cwd)).toEqual([]);

    await removeMcpConfigServer("ask-agent", "ask-agent-global", "browserOnly");
    expect(await loadAskAgentMcpConfigs()).toEqual([]);
  });

  it("rejects invalid structured MCP config mutations", async () => {
    await expect(
      upsertMcpConfigServer({
        profile: "ask-agent",
        scope: "global",
        server: { name: "bad", command: "bad" },
      }),
    ).rejects.toThrow("scope_not_writable");

    await expect(
      upsertMcpConfigServer({
        profile: "ask-agent",
        scope: "ask-agent-global",
        server: { name: "__proto__", command: "bad" },
      }),
    ).rejects.toThrow("invalid_server_name");

    await expect(
      upsertMcpConfigServer({
        profile: "ask-agent",
        scope: "ask-agent-global",
        server: { name: "remote", type: "sse", url: "file:///tmp/mcp" },
      }),
    ).rejects.toThrow("invalid_url");
  });
});
