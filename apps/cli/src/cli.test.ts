import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { SessionPreferencesStore } from "@agentlink/node-host";

import {
  createInkInteractionBroker,
  createQueuedControlPresenter,
  isBackgroundCommandAcknowledged,
  runCli,
  type CliIo,
} from "./cli.js";

function harness(isTty = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk) => (stdout += String(chunk)));
  error.on("data", (chunk) => (stderr += String(chunk)));
  const io: CliIo = {
    input,
    output,
    error,
    isTty,
    readSecret: vi.fn(async () => "secret"),
    openExternal: vi.fn(async () => undefined),
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

describe("runCli", () => {
  it("prints help without creating host state", async () => {
    const test = harness();
    await expect(runCli(["--help"], test.io, {})).resolves.toBe(0);
    expect(test.stdout()).toContain("status");
    expect(test.stdout()).toContain("lsp");
  });

  it("shows contextual authentication help for an incomplete command", async () => {
    const test = harness();
    await expect(runCli(["auth"], test.io, {})).resolves.toBe(1);
    expect(test.stderr()).toContain(
      "Usage: agentlink auth [options] [command]",
    );
    expect(test.stderr()).toContain("codex");
    expect(test.stderr()).toContain("openai");
    expect(test.stderr()).not.toContain("Unknown or incomplete command");
  });

  it("suggests nearby commands and shows relevant help", async () => {
    const test = harness();
    await expect(runCli(["auth", "codxe"], test.io, {})).resolves.toBe(1);
    expect(test.stderr()).toContain("unknown command 'codxe'");
    expect(test.stderr()).toContain("Did you mean codex?");
    expect(test.stderr()).toContain("Usage: agentlink auth");
  });

  it("reports optional language intelligence as unavailable without host startup", async () => {
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-cli-lsp-status-"),
    );
    const test = harness();
    try {
      await expect(
        runCli(["lsp", "status"], test.io, { AGENTLINK_HOME: dataRoot }),
      ).resolves.toBe(0);
      expect(JSON.parse(test.stdout())).toMatchObject({
        installation: {
          state: "unavailable",
          recipe: {
            languageServer: { version: "5.3.0" },
            typescript: { version: "5.9.3" },
          },
        },
        project: { enabled: false },
      });
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("reports shared project servers as configured without connecting them", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-cli-mcp-"),
    );
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    const test = harness();
    try {
      await fs.mkdir(path.join(projectRoot, ".agentlink"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectRoot, ".agentlink", "mcp.json"),
        JSON.stringify({ mcpServers: { records: { command: "node" } } }),
      );
      await expect(
        runCli(["mcp", "status", "--project", projectRoot], test.io, {
          AGENTLINK_HOME: dataRoot,
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(test.stdout())).toMatchObject({
        sharedServersConfigured: expect.arrayContaining(["records"]),
        configured: [],
        untrustedProjectDeclarations: [],
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("does not start OAuth when CLI reauthentication is noninteractive or the server is missing", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-cli-reauth-"),
    );
    const projectRoot = path.join(parent, "project");
    const test = harness();
    try {
      await fs.mkdir(projectRoot);
      await fs.mkdir(path.join(parent, ".agents"));
      await fs.writeFile(
        path.join(parent, ".agents", "mcp.json"),
        JSON.stringify({
          mcpServers: { records: { type: "http", url: "https://1.1.1.1/mcp" } },
        }),
      );
      await expect(
        runCli(
          ["mcp", "reauthenticate", "records", "--project", projectRoot],
          test.io,
          {
            AGENTLINK_HOME: path.join(parent, "data"),
          },
        ),
      ).rejects.toThrow("requires an interactive terminal");
      const interactive = harness(true);
      await expect(
        runCli(
          ["mcp", "reauthenticate", "missing", "--project", projectRoot],
          interactive.io,
          {
            AGENTLINK_HOME: path.join(parent, "data"),
          },
        ),
      ).rejects.toThrow("Enabled remote MCP server 'missing' not found");
      expect(interactive.io.openExternal).not.toHaveBeenCalled();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("does not report a shadowed legacy server as active", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-cli-mcp-"),
    );
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    const test = harness();
    try {
      await fs.mkdir(path.join(projectRoot, ".agents"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectRoot, ".agents", "mcp.json"),
        JSON.stringify({ mcpServers: { records: { disabled: true } } }),
      );
      await fs.mkdir(path.join(dataRoot, "cli"), { recursive: true });
      await fs.writeFile(
        path.join(dataRoot, "cli", "mcp.json"),
        JSON.stringify({
          schemaVersion: 1,
          trustedProjectServerIds: [],
          servers: [
            {
              id: "records",
              transport: "streamable-http",
              url: "https://example.test/mcp",
            },
          ],
        }),
      );
      await expect(
        runCli(["mcp", "status", "--project", projectRoot], test.io, {
          AGENTLINK_HOME: dataRoot,
        }),
      ).resolves.toBe(0);
      const status = JSON.parse(test.stdout());
      expect(status.configured).toEqual([]);
      expect(status.shadowedLegacyServerIds).toEqual(["records"]);
      expect(status.sharedServersConfigured).not.toContain("records");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("shows command help when an option value is missing", async () => {
    const test = harness();
    await expect(runCli(["chat", "--session"], test.io, {})).resolves.toBe(1);
    expect(test.stderr()).toContain("option '--session <id>' argument missing");
    expect(test.stderr()).toContain("Usage: agentlink chat [options]");
  });

  it("writes config model changes to shared code-mode preferences", async () => {
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-cli-preferences-"),
    );
    const test = harness();
    try {
      await expect(
        runCli(["config", "model", "codex/gpt-5.6-sol"], test.io, {
          AGENTLINK_HOME: dataRoot,
        }),
      ).resolves.toBe(0);
      await expect(
        new SessionPreferencesStore({ dataRoot }).read(),
      ).resolves.toMatchObject({
        modeModels: { code: "gpt-5.6-sol" },
      });
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("requires interactive confirmation before enabling an unsandboxed project server", async () => {
    const test = harness();
    await expect(
      runCli(["lsp", "enable", "--project", process.cwd()], test.io, {
        AGENTLINK_HOME: `/tmp/agentlink-cli-test-${process.pid}`,
      }),
    ).rejects.toThrow(
      "TypeScript language-server project enablement requires an interactive terminal",
    );
  });

  it("rejects non-interactive coding sessions", async () => {
    const test = harness();
    await expect(
      runCli(["chat", "--project", process.cwd()], test.io, {
        AGENTLINK_HOME: `/tmp/agentlink-cli-test-${process.pid}`,
      }),
    ).rejects.toThrow("Coding chat requires an interactive terminal");
  });

  it("requires the exact background concurrency acknowledgement", () => {
    expect(
      isBackgroundCommandAcknowledged({
        requestId: "background",
        cancelled: false,
        text: "  ALLOW BACKGROUND  ",
      }),
    ).toBe(true);
    expect(
      isBackgroundCommandAcknowledged({
        requestId: "background",
        cancelled: false,
        text: "allow",
      }),
    ).toBe(false);
    expect(
      isBackgroundCommandAcknowledged({
        requestId: "background",
        cancelled: true,
      }),
    ).toBe(false);
  });

  it("rejects a terminating control response instead of treating it as denial", async () => {
    const presentControl = createQueuedControlPresenter(
      {
        runPrompt: async (operation) =>
          await operation(new AbortController().signal),
      },
      async (request) => ({
        requestId: request.id,
        cancelled: true,
        terminate: true,
      }),
    );

    await expect(
      presentControl({
        id: "approval-cancel",
        kind: "approval",
        title: "Review write",
        body: ["src/index.ts"],
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a queued MCP prompt when its operation is cancelled", async () => {
    const operation = new AbortController();
    const presenter = vi.fn(async (_request, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false);
      operation.abort();
      return {
        requestId: "mcp",
        cancelled: false as const,
        optionId: "accept",
      };
    });
    const queued = createQueuedControlPresenter(
      { runPrompt: async (run) => run(new AbortController().signal) },
      presenter,
    );
    await expect(
      queued({ id: "mcp", title: "MCP input", body: [] }, operation.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("routes MCP status and form elicitation through the control presenter", async () => {
    const onStatus = vi.fn();
    const presentControl = vi.fn(async (request) => ({
      requestId: request.id,
      cancelled: false as const,
      ...(request.options
        ? { optionId: request.options[0].id }
        : { text: "answer" }),
    }));
    const broker = createInkInteractionBroker({
      controller: { notifyBackgroundApproval: vi.fn() } as never,
      io: harness(true).io,
      mcpLaunchGrants: new Set(),
      mcpNetworkGrants: new Set(),
      presentControl,
      onStatus,
    });
    broker.notifyMcpStatus("MCP server disconnected");
    expect(onStatus).toHaveBeenCalledWith("MCP server disconnected");
    const server = {
      name: "records",
      status: "error" as const,
      error: "auth failed",
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      tools: [],
    };
    broker.notifyMcpServers([server]);
    expect(onStatus).toHaveBeenLastCalledWith(
      "MCP records: error (auth failed)",
    );
    broker.notifyMcpServers([
      { ...server, status: "connected", error: undefined },
    ]);
    expect(onStatus).toHaveBeenLastCalledWith("MCP records: connected");
    await expect(
      broker.elicitMcpForm({
        principal: { tenantId: "tenant", subjectId: "user" },
        sessionId: "session",
        turnId: "turn",
        serverName: "records",
        message: "Please provide input",
        fields: [{ name: "reply", kind: "string", required: true }],
      }),
    ).resolves.toEqual({ action: "accept", content: { reply: "answer" } });
    expect(presentControl).toHaveBeenCalledTimes(2);
    expect(presentControl.mock.calls[0][0].title).toContain("records");
    expect(presentControl.mock.calls[1][0].title).toBe("reply");
  });

  it("serializes Ink questions and MCP reviews through the controller prompt queue", async () => {
    const runPrompt = vi.fn(
      async (operation) => await operation(new AbortController().signal),
    );
    const renderControl = vi.fn(async (request) => ({
      requestId: request.id,
      cancelled: false as const,
      optionId: request.options?.[0]?.id,
    }));
    const presentControl = createQueuedControlPresenter(
      { runPrompt },
      renderControl,
    );
    const broker = createInkInteractionBroker({
      controller: {
        notifyBackgroundApproval: vi.fn(),
      } as never,
      io: harness(true).io,
      mcpLaunchGrants: new Set(),
      mcpNetworkGrants: new Set(),
      presentControl,
      onStatus: vi.fn(),
    });

    await expect(
      broker.askQuestion({
        id: "question-1",
        kind: "multiple_choice",
        question: "Ship this?",
        options: ["Yes", "No"],
        recommended: "Yes",
      }),
    ).resolves.toBe("Yes");
    await expect(
      broker.confirmMcpLaunch({
        kind: "mcp_stdio_launch",
        unsandboxed: true,
        serverId: "tools",
        source: "project",
        command: "/usr/bin/node",
        args: ["server.js"],
        cwd: "/project",
        environmentKeys: [],
        credentialIds: [],
        operationDigest: "launch-digest",
      }),
    ).resolves.toBe(true);

    await expect(
      broker.confirmSharedMcpAdmission({
        kind: "shared_mcp_project_admission",
        serverId: "shared",
        projectRoot: "/project",
        transport: "stdio",
        command: "node",
        argumentCount: 1,
        environmentKeys: ["TOKEN"],
        headerNames: [],
        operationDigest: "shared-admission-digest",
      }),
    ).resolves.toBe(true);
    await expect(
      broker.confirmSharedMcpLaunch({
        kind: "shared_mcp_stdio_launch",
        serverId: "shared",
        command: "node",
        argumentCount: 1,
        cwd: "/project",
        environmentKeys: ["TOKEN"],
        operationDigest: "shared-launch-digest",
      }),
    ).resolves.toBe(true);
    await expect(
      broker.confirmSharedMcpNetwork({
        kind: "shared_mcp_network_destination",
        serverId: "shared",
        configuredEndpoint: "https://example.test/mcp",
        destination: "https://example.test/mcp",
        headerNames: [],
        oauth: false,
        operationDigest: "shared-network-digest",
      }),
    ).resolves.toBe(true);

    expect(runPrompt).toHaveBeenCalledTimes(5);
    expect(renderControl.mock.calls.map(([request]) => request.title)).toEqual([
      "Agent question",
      "Review unsandboxed MCP server launch",
      "Trust project MCP server definition",
      "Review unsandboxed MCP server launch",
      "Review MCP network destination",
    ]);
  });
});
