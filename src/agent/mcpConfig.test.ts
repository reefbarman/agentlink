import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "path";
import { mkdir, rm, writeFile } from "fs/promises";

import { loadMcpConfigs } from "./mcpConfig.js";
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
});
