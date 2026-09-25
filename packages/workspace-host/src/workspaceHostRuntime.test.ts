import { describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";
import { createWorkspaceHost } from "./workspaceHostRuntime.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function toolCall(name: string, input: Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "tool-response",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function completion(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "response",
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: "stop",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("createWorkspaceHost", () => {
  it("continues a durable project session after reopening the host", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-host-"));
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    await fs.mkdir(projectRoot);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(completion("first reply"))
      .mockResolvedValueOnce(completion("second reply"));
    const options = {
      projectRoot,
      dataRoot,
      providers: [
        {
          type: "openai-compatible" as const,
          id: "fixture",
          baseURL: "https://example.invalid/v1",
          noAuth: true as const,
          models: [
            {
              id: "fixture-model",
              contextWindow: 32_768,
              maxOutputTokens: 4_096,
              supportsToolUse: true,
            },
          ],
          fetch,
        },
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
    };

    const first = await createWorkspaceHost({ ...options, ownerId: "first" });
    const sessionId = (
      await first.createSession({ sessionId: "durable-session" })
    ).sessionId;
    await expect(
      first.runTurn(sessionId, "first message"),
    ).resolves.toMatchObject({
      status: "completed",
      text: "first reply",
    });

    const reopened = await createWorkspaceHost({
      ...options,
      ownerId: "reopened",
    });
    await expect(reopened.listSessions()).resolves.toEqual([
      expect.objectContaining({ sessionId, state: "idle" }),
    ]);
    await expect(
      reopened.runTurn(sessionId, "second message"),
    ).resolves.toMatchObject({ status: "completed", text: "second reply" });
    const hydrated = await reopened.readSession(sessionId);
    expect(hydrated.record.messages).toHaveLength(4);
    expect(hydrated.record.messages).toMatchObject([
      { role: "user", content: "first message" },
      { role: "assistant" },
      { role: "user", content: "second message" },
      { role: "assistant" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gates language tools by host enablement and keeps disabled context explicit", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-host-lsp-"),
    );
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "index.ts"),
      "export const value = 1;\n",
    );
    const languageToolNames = [
      "get_diagnostics",
      "get_symbols",
      "go_to_definition",
      "get_references",
      "get_hover",
    ];
    const requestBodies: Array<{
      messages?: Array<{ role?: string; content?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    }> = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_input, init) => {
        const body = JSON.parse(
          String(init?.body),
        ) as (typeof requestBodies)[number];
        requestBodies.push(body);
        return requestBodies.length === 1
          ? toolCall("get_context", { path: "index.ts" })
          : completion("context inspected");
      });
    const common = {
      projectRoot,
      dataRoot,
      providers: [
        {
          type: "openai-compatible" as const,
          id: "fixture",
          baseURL: "https://example.invalid/v1",
          noAuth: true as const,
          models: [
            {
              id: "fixture-model",
              contextWindow: 32_768,
              maxOutputTokens: 4_096,
              supportsToolUse: true,
            },
          ],
          fetch,
        },
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true as const },
    };
    const disabled = await createWorkspaceHost({
      ...common,
      ownerId: "language-disabled",
    });
    try {
      const sessionId = (await disabled.createSession()).sessionId;
      await expect(
        disabled.runTurn(sessionId, "inspect context"),
      ).resolves.toMatchObject({
        status: "completed",
      });
      const advertised = requestBodies[0]?.tools?.map(
        (tool) => tool.function?.name,
      );
      expect(advertised).not.toEqual(expect.arrayContaining(languageToolNames));
      const toolResult = requestBodies[1]?.messages?.find(
        (message) => message.role === "tool",
      )?.content;
      expect(toolResult).toContain('"diagnostics":{"state":"unavailable"');
      expect(toolResult).toContain('"symbols":{"state":"unavailable"');
    } finally {
      await disabled.close();
    }

    requestBodies.length = 0;
    fetch.mockReset().mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return completion("language tools advertised");
    });
    const enabled = await createWorkspaceHost({
      ...common,
      ownerId: "language-enabled",
      languageIntelligence: { enabled: true },
    });
    try {
      const sessionId = (await enabled.createSession()).sessionId;
      await enabled.runTurn(sessionId, "inspect TypeScript");
      const advertised = requestBodies[0]?.tools
        ?.map((tool) => tool.function?.name)
        .filter((name): name is string => Boolean(name));
      expect(
        advertised?.filter((name) => languageToolNames.includes(name)),
      ).toEqual(languageToolNames);
      await expect(enabled.languageStatus()).resolves.toMatchObject({
        state: "unavailable",
        installation: { state: "unavailable" },
      });
    } finally {
      await enabled.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("activates host-approved project instructions and advertises artifact tools", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-host-"));
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    await fs.mkdir(path.join(projectRoot, "skills", "test-helper"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectRoot, "AGENTS.md"),
      "Use the project artifact instruction.",
    );
    await fs.writeFile(
      path.join(projectRoot, "skills", "test-helper", "SKILL.md"),
      "---\nname: test-helper\ndescription: Test helper\n---\nUse the helper.",
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages?: Array<{ role?: string; content?: string }>;
          tools?: Array<{ function?: { name?: string } }>;
        };
        const system = body.messages?.find(
          (message) => message.role === "system",
        )?.content;
        expect(system).toContain("Use the project artifact instruction.");
        expect(body.tools?.map((tool) => tool.function?.name)).toEqual(
          expect.arrayContaining(["list_artifacts", "load_artifact"]),
        );
        return completion("artifacts active");
      });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot,
      ownerId: "artifacts",
      providers: [
        {
          type: "openai-compatible",
          id: "fixture",
          baseURL: "https://example.invalid/v1",
          noAuth: true,
          models: [
            {
              id: "fixture-model",
              contextWindow: 32_768,
              maxOutputTokens: 4_096,
              supportsToolUse: true,
            },
          ],
          fetch,
        },
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      artifacts: {
        roots: [{ id: "project", scope: "project", rootPath: projectRoot }],
      },
    });
    try {
      const sessionId = (await host.createSession()).sessionId;
      await expect(
        host.runTurn(sessionId, "use project context"),
      ).resolves.toMatchObject({
        status: "completed",
        text: "artifacts active",
      });
    } finally {
      await host.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("denies a reviewed file proposal without writing", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-host-"));
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    await fs.mkdir(projectRoot);
    const filePath = path.join(projectRoot, "file.txt");
    await fs.writeFile(filePath, "before\n");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        toolCall("write_file", {
          path: "file.txt",
          content: "after\n",
          expectedContentHash: createHash("sha256")
            .update("before\n")
            .digest("hex"),
        }),
      )
      .mockResolvedValueOnce(completion("kept unchanged"));
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot,
      ownerId: "deny",
      providers: [
        {
          type: "openai-compatible",
          id: "fixture",
          baseURL: "https://example.invalid/v1",
          noAuth: true,
          models: [
            {
              id: "fixture-model",
              contextWindow: 32_768,
              maxOutputTokens: 4_096,
              supportsToolUse: true,
            },
          ],
          fetch,
        },
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
    });
    const sessionId = (await host.createSession()).sessionId;

    await expect(
      host.runTurn(sessionId, "change the file"),
    ).resolves.toMatchObject({
      status: "suspended",
    });
    await expect(
      host.resumeInteraction(sessionId, "deny"),
    ).resolves.toMatchObject({
      status: "completed",
      text: "kept unchanged",
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("before\n");
  });

  it("rejects a stale restarted proposal before dispatching or writing", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-host-"));
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    await fs.mkdir(projectRoot);
    const filePath = path.join(projectRoot, "file.txt");
    await fs.writeFile(filePath, "before\n");
    const firstFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      toolCall("write_file", {
        path: "file.txt",
        content: "after\n",
        expectedContentHash: createHash("sha256")
          .update("before\n")
          .digest("hex"),
      }),
    );
    const provider = (fetch: typeof globalThis.fetch) => ({
      type: "openai-compatible" as const,
      id: "fixture",
      baseURL: "https://example.invalid/v1",
      noAuth: true as const,
      models: [
        {
          id: "fixture-model",
          contextWindow: 32_768,
          maxOutputTokens: 4_096,
          supportsToolUse: true,
        },
      ],
      fetch,
    });
    const common = {
      projectRoot,
      dataRoot,
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true as const },
    };
    const first = await createWorkspaceHost({
      ...common,
      ownerId: "first",
      providers: [provider(firstFetch)],
    });
    const sessionId = (await first.createSession()).sessionId;
    await expect(
      first.runTurn(sessionId, "change the file"),
    ).resolves.toMatchObject({
      status: "suspended",
    });

    await fs.writeFile(filePath, "external\n");
    const reopenedFetch = vi.fn<typeof globalThis.fetch>();
    const reopened = await createWorkspaceHost({
      ...common,
      ownerId: "reopened",
      providers: [provider(reopenedFetch)],
    });
    await expect(
      reopened.revalidatePendingInteraction(sessionId),
    ).resolves.toMatchObject({
      ok: false,
      reason: "File baseline changed before review",
    });
    await expect(
      reopened.resumeInteraction(sessionId, "allow"),
    ).rejects.toThrow("Stale proposal rejected");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("external\n");
    expect(reopenedFetch).not.toHaveBeenCalled();
    await expect(reopened.readSession(sessionId)).resolves.toMatchObject({
      record: { runState: { phase: "interrupted" } },
    });
  });

  it("re-presents and executes the exact prepared command launch after restart", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-host-"));
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    await fs.mkdir(projectRoot);
    const providers = (fetch: typeof globalThis.fetch) => [
      {
        type: "openai-compatible" as const,
        id: "fixture",
        baseURL: "https://example.invalid/v1",
        noAuth: true as const,
        models: [
          {
            id: "fixture-model",
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
            supportsToolUse: true,
          },
        ],
        fetch,
      },
    ];
    const common = {
      projectRoot,
      dataRoot,
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      commands: {
        enabled: true as const,
        resolveEnvironment: () => ({
          PATH: process.env.PATH,
          SECRET_COMMAND_VALUE: "must-not-be-persisted",
        }),
      },
    };
    const firstFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      toolCall("execute_command", {
        command: "printf exact-restarted-command",
      }),
    );
    const first = await createWorkspaceHost({
      ...common,
      ownerId: "first-process",
      providers: providers(firstFetch),
    });
    const sessionId = (
      await first.createSession({ sessionId: "command-approval-session" })
    ).sessionId;

    const suspended = await first.runTurn(sessionId, "run the command");
    expect(suspended).toMatchObject({
      status: "suspended",
      interaction: {
        toolName: "execute_command",
        displayContent: {
          kind: "command_launch",
          command: "printf exact-restarted-command",
          mode: "foreground",
          unsandboxed: true,
        },
      },
    });
    const durableState = await fs.readFile(
      path.join(
        dataRoot,
        "projects",
        first.project.id,
        "sessions",
        "agent-state.json",
      ),
      "utf8",
    );
    expect(durableState).toContain("SECRET_COMMAND_VALUE");
    expect(durableState).not.toContain("must-not-be-persisted");
    await first.close();

    const reopenedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(completion("done"));
    const reopened = await createWorkspaceHost({
      ...common,
      ownerId: "second-process",
      providers: providers(reopenedFetch),
    });
    try {
      await expect(
        reopened.revalidatePendingInteraction(sessionId),
      ).resolves.toEqual({ ok: true });
      await expect(
        reopened.resumeInteraction(sessionId, "allow"),
      ).resolves.toMatchObject({ status: "completed", text: "done" });
      const commands = reopened.listCommands({ sessionId });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        command: "printf exact-restarted-command",
        state: "completed",
        exitCode: 0,
      });
      expect(
        reopened
          .observeCommand(commands[0]!.commandId, { sessionId })
          .output.map((chunk) => chunk.text)
          .join(""),
      ).toBe("exact-restarted-command");
      expect(reopenedFetch).toHaveBeenCalledTimes(1);
    } finally {
      await reopened.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("re-presents a durable file proposal after restart and executes only the resumed decision", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-host-"));
    const projectRoot = path.join(parent, "project");
    const dataRoot = path.join(parent, "data");
    await fs.mkdir(projectRoot);
    const filePath = path.join(projectRoot, "file.txt");
    await fs.writeFile(filePath, "before\n");
    const expectedContentHash = createHash("sha256")
      .update("before\n")
      .digest("hex");
    const providers = (fetch: typeof globalThis.fetch) => [
      {
        type: "openai-compatible" as const,
        id: "fixture",
        baseURL: "https://example.invalid/v1",
        noAuth: true as const,
        models: [
          {
            id: "fixture-model",
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
            supportsToolUse: true,
          },
        ],
        fetch,
      },
    ];
    const firstFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      toolCall("write_file", {
        path: "file.txt",
        content: "after\n",
        expectedContentHash,
      }),
    );
    const first = await createWorkspaceHost({
      projectRoot,
      dataRoot,
      ownerId: "first",
      providers: providers(firstFetch),
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
    });
    const sessionId = (
      await first.createSession({ sessionId: "approval-session" })
    ).sessionId;

    const suspended = await first.runTurn(sessionId, "change the file");
    expect(suspended).toMatchObject({
      status: "suspended",
      interaction: {
        toolName: "write_file",
        displayContent: {
          kind: "file_write",
          path: "file.txt",
          expectedContentHash,
        },
      },
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("before\n");

    const reopenedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(completion("done"));
    const reopened = await createWorkspaceHost({
      projectRoot,
      dataRoot,
      ownerId: "reopened",
      providers: providers(reopenedFetch),
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
    });
    await expect(reopened.readSession(sessionId)).resolves.toMatchObject({
      pendingInteraction: {
        request: {
          displayContent: {
            kind: "file_write",
            path: "file.txt",
            proposedContentHash: createHash("sha256")
              .update("after\n")
              .digest("hex"),
          },
        },
      },
    });
    await expect(
      reopened.resumeInteraction(sessionId, "allow"),
    ).resolves.toMatchObject({ status: "completed", text: "done" });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("after\n");
  });
});
