import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpConfigEntries,
  getMcpConfigRevision,
  getMcpConfigSources,
  loadAskAgentMcpConfigs,
  loadMcpConfigs,
  mutateMcpConfigBatch,
  removeMcpConfigServer,
  upsertMcpConfigServer,
} from "./mcpConfig.js";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { dirname, join } from "path";

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

  it("interpolates environment references in env and header values", async () => {
    const previousToken = process.env.AGENTLINK_MCP_TEST_TOKEN;
    process.env.AGENTLINK_MCP_TEST_TOKEN = "resolved-token";
    try {
      await writeJson(join(cwd, ".agentlink", "mcp.json"), {
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.com/mcp",
            env: { TOKEN: "${AGENTLINK_MCP_TEST_TOKEN}" },
            headers: {
              Authorization: "Bearer ${AGENTLINK_MCP_TEST_TOKEN}",
            },
          },
        },
      });

      expect(await loadMcpConfigs(cwd)).toMatchObject([
        {
          name: "remote",
          env: { TOKEN: "resolved-token" },
          headers: { Authorization: "Bearer resolved-token" },
        },
      ]);
    } finally {
      if (previousToken === undefined)
        delete process.env.AGENTLINK_MCP_TEST_TOKEN;
      else process.env.AGENTLINK_MCP_TEST_TOKEN = previousToken;
    }
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

  it("replaces inherited allowed tools, including with an empty list", async () => {
    await writeJson(join(home, ".agentlink", "mcp.json"), {
      mcpServers: {
        linear: {
          command: "linear-mcp",
          allowedTools: ["read", "write"],
        },
      },
    });
    await writeJson(join(cwd, ".agentlink", "mcp.json"), {
      mcpServers: {
        linear: {
          allowedTools: [],
        },
      },
    });

    expect(await loadMcpConfigs(cwd)).toMatchObject([
      {
        name: "linear",
        allowedTools: [],
      },
    ]);
  });

  it("honors explicit disabled false from a higher-priority source", async () => {
    await writeJson(join(home, ".agentlink", "mcp.json"), {
      mcpServers: {
        linear: {
          command: "linear-mcp",
          disabled: true,
        },
      },
    });
    await writeJson(join(cwd, ".agentlink", "mcp.json"), {
      mcpServers: {
        linear: {
          disabled: false,
        },
      },
    });

    expect(await loadMcpConfigs(cwd)).toMatchObject([
      {
        name: "linear",
        disabled: false,
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
        writableOverrideScopes: ["ask-agent-global"],
        envKeys: [],
        headerKeys: ["Authorization"],
        sourceContributions: [
          expect.objectContaining({
            scope: "global",
            editable: false,
            headerKeys: ["Authorization"],
          }),
          expect.objectContaining({
            scope: "ask-agent-global",
            editable: true,
          }),
        ],
      },
    ]);
  });

  it("reports safe source read status for missing, available, and invalid files", async () => {
    const invalidPath = join(home, ".agentlink", "mcp.json");
    const availablePath = join(cwd, ".agentlink", "mcp.json");
    await mkdir(dirname(invalidPath), { recursive: true });
    await writeFile(invalidPath, '{ "mcpServers": {', "utf-8");
    await writeJson(availablePath, { mcpServers: {} });

    const sources = await getMcpConfigSources("main", cwd);
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: invalidPath,
          exists: true,
          readStatus: "invalid",
          readError: "invalid_json",
        }),
        expect.objectContaining({
          path: availablePath,
          exists: true,
          readStatus: "available",
        }),
        expect.objectContaining({
          path: join(home, ".agents", "mcp.json"),
          exists: false,
          readStatus: "missing",
        }),
      ]),
    );
    expect(
      sources
        .filter((source) => source.readStatus !== "invalid")
        .every((source) => !("readError" in source)),
    ).toBe(true);
    expect(JSON.stringify(sources)).not.toContain("Unexpected");
  });

  it("reports structurally invalid server maps without projecting entries", async () => {
    const configPath = join(home, ".agentlink", "mcp.json");
    await writeJson(configPath, { mcpServers: { invalid: "not-an-object" } });

    const sources = await getMcpConfigSources("main", cwd);
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: configPath,
          readStatus: "invalid",
          readError: "invalid_json",
        }),
      ]),
    );
    expect(await buildMcpConfigEntries("main", cwd)).toEqual([]);
  });

  it("fails closed without changing malformed existing configuration", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    const malformed = '{ "mcpServers": { "existing": ';
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, malformed, "utf-8");

    await expect(
      upsertMcpConfigServer({
        profile: "ask-agent",
        scope: "ask-agent-global",
        server: { name: "replacement", command: "replacement-mcp" },
      }),
    ).rejects.toThrow("mcp_config_invalid");

    expect(await readFile(configPath, "utf-8")).toBe(malformed);
  });

  it("fails closed when the existing config path is unreadable as a file", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await mkdir(configPath, { recursive: true });

    await expect(
      upsertMcpConfigServer({
        profile: "ask-agent",
        scope: "ask-agent-global",
        server: { name: "replacement", command: "replacement-mcp" },
      }),
    ).rejects.toThrow("mcp_config_read_failed");
  });

  it("offers writable override scopes for inherited-only entries", async () => {
    await writeJson(join(home, ".agents", "mcp.json"), {
      mcpServers: {
        inheritedOnly: { command: "inherited-mcp" },
      },
    });

    expect(await buildMcpConfigEntries("main", cwd)).toMatchObject([
      {
        name: "inheritedOnly",
        editableScopes: [],
        writableOverrideScopes: ["global", "project"],
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

  it("applies a validated batch atomically and preserves unrelated JSON", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, {
      metadata: { owner: "local" },
      mcpServers: {
        existing: { command: "old", customField: "keep-on-other-server" },
        untouched: { command: "untouched", customField: true },
      },
    });
    const expectedRevision = await getMcpConfigRevision("ask-agent");

    const result = await mutateMcpConfigBatch({
      operationId: "batch-1",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision,
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: {
            name: "existing",
            command: "new",
            args: ["quoted path with spaces"],
          },
        },
        {
          kind: "upsert",
          conflictAction: "replace",
          server: {
            name: "added",
            type: "http",
            url: "https://example.com/mcp",
          },
        },
      ],
    });

    expect(result).toMatchObject({
      operationId: "batch-1",
      ok: true,
      configSaved: true,
      errors: [],
    });
    const written = JSON.parse(await readFile(configPath, "utf-8"));
    expect(written).toMatchObject({
      metadata: { owner: "local" },
      mcpServers: {
        existing: { command: "new", args: ["quoted path with spaces"] },
        untouched: { command: "untouched", customField: true },
        added: { type: "http", url: "https://example.com/mcp" },
      },
    });
  });

  it("rejects stale revisions without changing the file", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, {
      mcpServers: { first: { command: "first" } },
    });
    const staleRevision = await getMcpConfigRevision("ask-agent");
    await writeJson(configPath, {
      mcpServers: { second: { command: "second" } },
    });
    const before = await readFile(configPath, "utf-8");

    const result = await mutateMcpConfigBatch({
      operationId: "stale",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: staleRevision,
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "third", command: "third" },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      configSaved: false,
      errors: [{ code: "config_changed" }],
    });
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("validates every batch operation before writing any changes", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, {
      mcpServers: { stable: { command: "stable" } },
    });
    const before = await readFile(configPath, "utf-8");

    const result = await mutateMcpConfigBatch({
      operationId: "invalid-batch",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: await getMcpConfigRevision("ask-agent"),
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "valid", command: "valid" },
        },
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "invalid", type: "http", url: "file:///secret" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ operationIndex: 1 })]),
    );
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("rejects duplicate target names before writing", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, { mcpServers: {} });
    const before = await readFile(configPath, "utf-8");

    const result = await mutateMcpConfigBatch({
      operationId: "duplicates",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: await getMcpConfigRevision("ask-agent"),
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "duplicate", command: "first" },
        },
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "duplicate", command: "second" },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      configSaved: false,
      errors: [
        {
          code: "conflict_unresolved",
          message: "duplicate_operation_name",
          operationIndex: 1,
        },
      ],
    });
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("supports skip, replace, and rename conflict actions", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, {
      mcpServers: { existing: { command: "original" } },
    });

    let result = await mutateMcpConfigBatch({
      operationId: "conflict-skip",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: await getMcpConfigRevision("ask-agent"),
      operations: [
        {
          kind: "upsert",
          conflictAction: "skip",
          server: { name: "existing", command: "skipped" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.configSaved).toBe(false);

    result = await mutateMcpConfigBatch({
      operationId: "conflict-rename",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: await getMcpConfigRevision("ask-agent"),
      operations: [
        {
          kind: "upsert",
          conflictAction: "rename",
          renameTo: "renamed",
          server: { name: "existing", command: "renamed-command" },
        },
      ],
    });
    expect(result.ok).toBe(true);

    result = await mutateMcpConfigBatch({
      operationId: "conflict-replace",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: await getMcpConfigRevision("ask-agent"),
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "existing", command: "replacement" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    const written = JSON.parse(await readFile(configPath, "utf-8"));
    expect(written.mcpServers).toMatchObject({
      existing: { command: "replacement" },
      renamed: { command: "renamed-command" },
    });
  });

  it("applies preserve, patch, replace, and remove secret mutations", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://old.example.com/mcp",
          env: { KEEP: "one", REMOVE: "two" },
          headers: { Authorization: "old", Keep: "yes" },
        },
      },
    });

    let revision = await getMcpConfigRevision("ask-agent");
    let result = await mutateMcpConfigBatch({
      operationId: "secrets-patch",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: revision,
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: {
            name: "remote",
            type: "http",
            url: "https://new.example.com/mcp",
            env: { mode: "patch", set: { ADDED: "three" }, remove: ["REMOVE"] },
            headers: { mode: "preserve" },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);

    revision = await getMcpConfigRevision("ask-agent");
    result = await mutateMcpConfigBatch({
      operationId: "secrets-replace-remove",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: revision,
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: {
            name: "remote",
            type: "http",
            url: "https://new.example.com/mcp",
            env: { mode: "replace", set: { ONLY: "replacement" } },
            headers: { mode: "remove" },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);

    const written = JSON.parse(await readFile(configPath, "utf-8"));
    expect(written.mcpServers.remote).toEqual({
      type: "http",
      url: "https://new.example.com/mcp",
      env: { ONLY: "replacement" },
    });
  });

  it("preserves restrictive file mode and leaves no temporary files", async () => {
    const configPath = join(home, ".agentlink", "ask-agent", "mcp.json");
    await writeJson(configPath, { mcpServers: {} });
    await chmod(configPath, 0o640);

    const result = await mutateMcpConfigBatch({
      operationId: "mode",
      profile: "ask-agent",
      scope: "ask-agent-global",
      expectedRevision: await getMcpConfigRevision("ask-agent"),
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "server", command: "server" },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    expect(
      (await readdir(dirname(configPath))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
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
