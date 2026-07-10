import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseJsonWithComments } from "./jsonc.js";
import {
  LEGACY_AGENT_INTEGRATION_CLEANUP_STATE_KEY,
  runLegacyAgentIntegrationCleanup,
  type LegacyCleanupState,
  type LegacyCleanupStateStore,
} from "./legacyAgentIntegrationCleanup.js";

const tempDirs: string[] = [];

function makeFixture(): {
  root: string;
  homeDir: string;
  workspaceRoot: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-legacy-cleanup-"),
  );
  tempDirs.push(root);
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return { root, homeDir, workspaceRoot };
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function makeStateStore(
  initial?: LegacyCleanupState,
): LegacyCleanupStateStore & {
  value?: LegacyCleanupState;
  update: ReturnType<typeof vi.fn>;
} {
  const store = {
    value: initial,
    get<T>(key: string): T | undefined {
      expect(key).toBe(LEGACY_AGENT_INTEGRATION_CLEANUP_STATE_KEY);
      return store.value as T | undefined;
    },
    update: vi.fn(async (key: string, value: unknown) => {
      expect(key).toBe(LEGACY_AGENT_INTEGRATION_CLEANUP_STATE_KEY);
      store.value = value as LegacyCleanupState;
    }),
  };
  return store;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runLegacyAgentIntegrationCleanup", () => {
  it("removes only signed AgentLink artifacts across supported config formats", async () => {
    const { homeDir, workspaceRoot } = makeFixture();
    const state = makeStateStore();

    write(
      path.join(homeDir, ".claude.json"),
      `{
  // keep this global server
  "mcpServers": {
    "other": { "url": "https://example.test/mcp" },
    "agentlink": { "type": "http", "url": "http://localhost:47123/mcp" }
  },
  "metadata": {
    "mcpServers": {
      "agentlink": { "url": "http://localhost:47126/mcp" }
    }
  },
  "projects": {
    "/workspace/a": {
      "mcpServers": {
        "agentlink": { "url": "http://127.0.0.1:47124/mcp", "headers": { "Authorization": "Bearer secret" } },
        "other": { "url": "https://project.example/mcp", "metadata": { "agentlink": { "url": "http://localhost:9999/mcp" } } }
      }
    },
    "/workspace/remote": {
      "mcpServers": {
        "agentlink": { "url": "https://user-owned.example/mcp" }
      }
    },
    "/workspace/query": {
      "mcpServers": {
        "agentlink": { "url": "http://localhost:47125/mcp?profile=user-owned" }
      }
    }
  }
}
`,
    );
    write(
      path.join(
        homeDir,
        ".cline",
        "data",
        "settings",
        "cline_mcp_settings.json",
      ),
      JSON.stringify(
        {
          mcpServers: {
            agentlink: { url: "http://localhost:48000/mcp" },
            retained: { url: "https://cline.example/mcp" },
          },
        },
        null,
        2,
      ),
    );
    write(
      path.join(homeDir, ".codex", "config.toml"),
      `model = "gpt-5.3-codex"


approval_policy = "on-request"

[mcp_servers.agentlink]
url = "http://localhost:48001/mcp"
http_headers = { "Authorization" = "Bearer secret" }

[mcp_servers.retained]
url = "https://codex.example/mcp"
`,
    );
    write(
      path.join(homeDir, ".claude", "settings.json"),
      `{
  "hooks": {
    "PreToolUse": [
      // installed by AgentLink
      {
        "matcher": "^(Read|Edit|Write|Bash|Glob|Grep)$",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/enforce-agentlink.sh" },
          { "type": "command", "command": "$HOME/.claude/hooks/keep-me.sh" }
        ]
      },
      { "matcher": "^(Read|Edit|Write|Bash|Glob|Grep)$", "hooks": [{ "type": "command", "command": "$HOME/.claude/hooks/enforce-agentlink.ps1" }] },
      { "matcher": "^(Read|Edit|Write|Bash|Glob|Grep)$", "hooks": [{ "type": "command", "command": "powershell -File C:\\\\Users\\\\me\\\\.claude\\\\hooks\\\\enforce-agentlink.ps1" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo retained" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "$HOME/.claude/hooks/enforce-agentlink.sh" }] }
    ]
  },
  "metadata": {
    "hooks": {
      "PreToolUse": [
        { "matcher": "Bash", "hooks": [{ "type": "command", "command": "$HOME/.claude/hooks/enforce-agentlink.sh" }] }
      ]
    }
  },
  "theme": "dark"
}
`,
    );
    write(
      path.join(homeDir, ".claude", "hooks", "enforce-agentlink.sh"),
      "# AgentLink MCP equivalents should be used\n# The agentlink MCP server provides VS Code-integrated equivalents\n",
    );
    write(
      path.join(homeDir, ".claude", "hooks", "enforce-agentlink.ps1"),
      "# user-owned same-name script\nWrite-Output 'keep'\n",
    );
    write(
      path.join(homeDir, ".claude", "CLAUDE.md"),
      `Personal preface


Personal notes

<!-- BEGIN agentlink -->
Use AgentLink tools.
<!-- END agentlink -->

Personal suffix
`,
    );

    for (const [relativePath, containerKey] of [
      [".mcp.json", "mcpServers"],
      [".vscode/mcp.json", "servers"],
      [".roo/mcp.json", "mcpServers"],
      [".kilocode/mcp.json", "mcpServers"],
    ] as const) {
      write(
        path.join(workspaceRoot, relativePath),
        `{
  // preserve this comment
  "${containerKey}": {
    "other": { "url": "https://workspace.example/mcp" },
    "agentlink": { "url": "http://localhost:49000/mcp", "type": "http" }
  },
  "agentlink": { "url": "http://localhost:49999/mcp" }
}
`,
      );
    }
    for (const relativePath of [
      ".github/copilot-instructions.md",
      ".roo/rules/agentlink.md",
      ".clinerules",
      ".kilocode/rules/agentlink.md",
      "AGENTS.md",
    ]) {
      write(
        path.join(workspaceRoot, relativePath),
        `Keep before
<!-- BEGIN agentlink -->
Remove generated guidance.
<!-- END agentlink -->
Keep after
`,
      );
    }

    const claudeConfigPath = path.join(homeDir, ".claude.json");
    fs.chmodSync(claudeConfigPath, 0o640);

    const report = await runLegacyAgentIntegrationCleanup({
      homeDir,
      workspaceRoots: [workspaceRoot],
      state,
    });

    expect(report.failures).toEqual([]);
    expect(report.changedTargets).toContain("claude-config");
    expect(report.changedTargets).toContain("cline-config");
    expect(report.changedTargets).toContain("codex-config");
    expect(report.changedTargets).toContain("claude-hooks-config");
    expect(report.changedTargets).toContain("claude-instructions");
    expect(report.changedTargets).toContain("hook-script:enforce-agentlink.sh");
    expect(report.changedTargets).not.toContain(
      "hook-script:enforce-agentlink.ps1",
    );

    const claudeText = read(claudeConfigPath);
    const claude = parseJsonWithComments<Record<string, unknown>>(claudeText);
    expect(claudeText).toContain("// keep this global server");
    expect(
      (claude.mcpServers as Record<string, unknown>).agentlink,
    ).toBeUndefined();
    expect(
      (
        (claude.metadata as Record<string, unknown>).mcpServers as Record<
          string,
          unknown
        >
      ).agentlink,
    ).toEqual({ url: "http://localhost:47126/mcp" });
    const projects = claude.projects as Record<string, Record<string, unknown>>;
    const localServers = projects["/workspace/a"].mcpServers as Record<
      string,
      unknown
    >;
    expect(localServers.agentlink).toBeUndefined();
    expect(localServers.other).toMatchObject({
      metadata: { agentlink: { url: "http://localhost:9999/mcp" } },
    });
    expect(
      (projects["/workspace/remote"].mcpServers as Record<string, unknown>)
        .agentlink,
    ).toEqual({ url: "https://user-owned.example/mcp" });
    expect(
      (projects["/workspace/query"].mcpServers as Record<string, unknown>)
        .agentlink,
    ).toEqual({ url: "http://localhost:47125/mcp?profile=user-owned" });
    expect(fs.statSync(claudeConfigPath).mode & 0o777).toBe(0o640);

    const cline = JSON.parse(
      read(
        path.join(
          homeDir,
          ".cline",
          "data",
          "settings",
          "cline_mcp_settings.json",
        ),
      ),
    ) as { mcpServers: Record<string, unknown> };
    expect(cline.mcpServers).toEqual({
      retained: { url: "https://cline.example/mcp" },
    });

    const codex = read(path.join(homeDir, ".codex", "config.toml"));
    expect(codex).not.toContain("[mcp_servers.agentlink]");
    expect(codex).toContain(
      'model = "gpt-5.3-codex"\n\n\napproval_policy = "on-request"',
    );
    expect(codex).toContain("[mcp_servers.retained]");

    const settingsText = read(path.join(homeDir, ".claude", "settings.json"));
    const settings = parseJsonWithComments<{
      hooks: {
        PreToolUse: Array<{ hooks: Array<{ command: string }> }>;
        PostToolUse: Array<{ hooks: Array<{ command: string }> }>;
      };
      metadata: {
        hooks: {
          PreToolUse: Array<{ hooks: Array<{ command: string }> }>;
        };
      };
      theme: string;
    }>(settingsText);
    expect(settingsText).toContain("// installed by AgentLink");
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "^(Read|Edit|Write|Bash|Glob|Grep)$",
        hooks: [{ type: "command", command: "$HOME/.claude/hooks/keep-me.sh" }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "echo retained" }],
      },
    ]);
    expect(settings.metadata.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: "$HOME/.claude/hooks/enforce-agentlink.sh",
          },
        ],
      },
    ]);
    expect(settings.hooks.PostToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: "$HOME/.claude/hooks/enforce-agentlink.sh",
          },
        ],
      },
    ]);

    expect(
      fs.existsSync(
        path.join(homeDir, ".claude", "hooks", "enforce-agentlink.sh"),
      ),
    ).toBe(false);
    expect(
      read(path.join(homeDir, ".claude", "hooks", "enforce-agentlink.ps1")),
    ).toContain("user-owned");
    expect(read(path.join(homeDir, ".claude", "CLAUDE.md"))).toBe(
      "Personal preface\n\n\nPersonal notes\n\nPersonal suffix\n",
    );

    for (const [relativePath, containerKey] of [
      [".mcp.json", "mcpServers"],
      [".vscode/mcp.json", "servers"],
      [".roo/mcp.json", "mcpServers"],
      [".kilocode/mcp.json", "mcpServers"],
    ] as const) {
      const text = read(path.join(workspaceRoot, relativePath));
      const config = parseJsonWithComments<Record<string, unknown>>(text);
      expect(text).toContain("// preserve this comment");
      expect(
        (config[containerKey] as Record<string, unknown>).agentlink,
      ).toBeUndefined();
      expect(config.agentlink).toEqual({ url: "http://localhost:49999/mcp" });
    }
    for (const relativePath of [
      ".github/copilot-instructions.md",
      ".roo/rules/agentlink.md",
      ".clinerules",
      ".kilocode/rules/agentlink.md",
      "AGENTS.md",
    ]) {
      expect(read(path.join(workspaceRoot, relativePath))).toBe(
        "Keep before\nKeep after\n",
      );
    }

    expect(state.value?.version).toBe(1);
    expect(state.value?.completedTargets).toHaveLength(
      report.completedTargets.length,
    );
    expect(
      state.value?.completedTargets.some((id) => id.includes(workspaceRoot)),
    ).toBe(false);
  });

  it("reports malformed targets without rewriting them and retries later", async () => {
    const { homeDir } = makeFixture();
    const state = makeStateStore();
    const log = vi.fn();
    const configPath = path.join(homeDir, ".claude.json");
    const malformed = `{
  "mcpServers": {
    "agentlink": { "url": "http://localhost:47123/mcp" }
`;
    write(configPath, malformed);

    const first = await runLegacyAgentIntegrationCleanup({
      homeDir,
      workspaceRoots: [],
      state,
      log,
    });

    expect(first.failures).toEqual([
      expect.objectContaining({ target: "claude-config" }),
    ]);
    expect(read(configPath)).toBe(malformed);
    expect(state.value?.completedTargets).not.toContain("claude-config");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Legacy AgentLink cleanup failed for claude-config",
      ),
    );

    write(
      configPath,
      JSON.stringify({
        mcpServers: {
          agentlink: { url: "http://localhost:47123/mcp" },
          retained: { url: "https://example.test/mcp" },
        },
      }),
    );
    const second = await runLegacyAgentIntegrationCleanup({
      homeDir,
      workspaceRoots: [],
      state,
    });

    expect(second.failures).toEqual([]);
    expect(second.completedTargets).toEqual(["claude-config"]);
    expect(JSON.parse(read(configPath))).toEqual({
      mcpServers: { retained: { url: "https://example.test/mcp" } },
    });
    expect(state.value?.completedTargets).toContain("claude-config");
  });

  it("retries a target when progress persistence fails after file cleanup", async () => {
    const { homeDir } = makeFixture();
    const configPath = path.join(homeDir, ".claude.json");
    write(
      configPath,
      JSON.stringify({
        mcpServers: { agentlink: { url: "http://localhost:47123/mcp" } },
      }),
    );
    let value: LegacyCleanupState | undefined;
    let failFirstUpdate = true;
    const state: LegacyCleanupStateStore = {
      get: <T>() => value as T | undefined,
      update: async (_key, next) => {
        if (failFirstUpdate) {
          failFirstUpdate = false;
          throw new Error("storage unavailable");
        }
        value = next as LegacyCleanupState;
      },
    };

    const first = await runLegacyAgentIntegrationCleanup({
      homeDir,
      workspaceRoots: [],
      state,
    });
    expect(first.changedTargets).toEqual(["claude-config"]);
    expect(first.failures).toEqual([
      { target: "claude-config", error: "storage unavailable" },
    ]);
    expect(JSON.parse(read(configPath))).toEqual({ mcpServers: {} });

    const second = await runLegacyAgentIntegrationCleanup({
      homeDir,
      workspaceRoots: [],
      state,
    });
    expect(second.changedTargets).toEqual([]);
    expect(second.completedTargets).toEqual(["claude-config"]);
    expect(value?.completedTargets).toContain("claude-config");
  });
});
