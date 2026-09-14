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

    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(renderControl.mock.calls.map(([request]) => request.title)).toEqual([
      "Agent question",
      "Review unsandboxed MCP server launch",
    ]);
  });
});
