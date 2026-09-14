import type {
  AgentInteractionRequest,
  AgentTurnEvent,
  AgentTurnResult,
} from "@agentlink/core";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceHost } from "@agentlink/workspace-host";
import { createStandaloneSessionController } from "./sessionController.js";

function interaction(): AgentInteractionRequest {
  return {
    interactionId: "approval-1",
    kind: "tool_authorization",
    summary: "Write file",
    toolCallId: "tool-1",
    toolName: "write_file",
    effect: "write",
    displayContent: { path: "src/index.ts" },
  };
}

function result(
  status: "completed" | "cancelled" = "completed",
): AgentTurnResult {
  const common = {
    sessionId: "session-1",
    turnId: "turn-1",
    sessionRevision: "2",
    execution: {} as never,
    provenance: {} as never,
  };
  return status === "completed"
    ? {
        ...common,
        status,
        text: "Hello",
        stopReason: undefined,
        usage: undefined,
      }
    : { ...common, status, reason: "cancelled", usage: undefined };
}

function turnEvent(value: object, sequence = 0): AgentTurnEvent {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    turnId: "turn-1",
    sequence,
    emittedAt: sequence,
    ...value,
  } as AgentTurnEvent;
}

function fixture(overrides: Partial<WorkspaceHost> = {}) {
  const host = {
    project: { root: "/project", id: "project-1" },
    principal: { tenantId: "local", subjectId: "project-1" },
    engine: {} as never,
    languageStatus: vi.fn(),
    listCommands: vi.fn(() => []),
    observeCommand: vi.fn(),
    stopCommand: vi.fn(),
    listCommandRules: vi.fn(() => []),
    addCommandRule: vi.fn(async () => undefined),
    acknowledgeBackgroundCommand: vi.fn(),
    readMcpConfiguration: vi.fn(),
    readSessionInteractions: vi.fn(() => ({ todos: [] })),
    listModels: vi.fn(async () => ({ models: [] })),
    setSessionModel: vi.fn(async () => undefined),
    setSessionReasoningEffort: vi.fn(async () => undefined),
    isBackgroundSession: vi.fn(() => false),
    listBackgroundAgents: vi.fn(() => []),
    listBackgroundApprovals: vi.fn(() => []),
    requestBackgroundApproval: vi.fn(),
    respondToBackgroundApproval: vi.fn(async () => undefined),
    steerBackgroundAgent: vi.fn(),
    stopBackgroundAgent: vi.fn(),
    close: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({ sessionId: "session-1" })),
    listSessions: vi.fn(async () => []),
    readSession: vi.fn(),
    deleteSession: vi.fn(),
    recoverInterrupted: vi.fn(async () => undefined),
    revalidatePendingInteraction: vi.fn(async () => ({ ok: true as const })),
    resumeInteraction: vi.fn(),
    runTurn: vi.fn(),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WorkspaceHost;
  return { host, controller: createStandaloneSessionController({ host }) };
}

describe("standalone session controller", () => {
  it("forwards media attachments while retaining display-only files", async () => {
    const { host, controller } = fixture({
      runTurn: vi.fn(async () => result("completed")),
    });
    await controller.initialize();

    await controller.submit("Review", [
      {
        display: { name: "note.txt", kind: "file", mimeType: "text/plain" },
      },
      {
        display: {
          name: "image.png",
          kind: "image",
          mimeType: "image/png",
          base64: "aW1hZ2U=",
        },
        model: {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
        },
      },
    ]);

    expect(host.runTurn).toHaveBeenCalledWith(
      "session-1",
      "Review",
      expect.objectContaining({
        attachments: [expect.objectContaining({ type: "image" })],
      }),
    );
    expect(controller.getState().transcript[0]?.attachments).toHaveLength(2);
  });

  it("initializes a new session and projects turn events without terminal IO", async () => {
    const { host, controller } = fixture({
      runTurn: vi.fn(async (_sessionId, _text, options) => {
        options?.onEvent?.(turnEvent({ type: "turn.started" }, 0));
        options?.onEvent?.(turnEvent({ type: "text.delta", text: "Hello" }, 1));
        options?.onEvent?.(
          turnEvent(
            {
              type: "tool.completed",
              toolCallId: "tool-1",
              toolName: "read_file",
              effect: "read",
              displayContent: { lines: 1 },
            },
            2,
          ),
        );
        return result();
      }),
    });

    await expect(controller.initialize()).resolves.toMatchObject({
      sessionId: "session-1",
      restored: false,
    });
    await expect(controller.submit("Say hello")).resolves.toMatchObject({
      status: "completed",
    });
    expect(controller.getState()).toMatchObject({
      phase: "idle",
      transcript: [
        { role: "user", text: "Say hello" },
        { role: "assistant", text: "Hello", streaming: false },
      ],
      tools: [{ toolCallId: "tool-1", status: "completed" }],
    });
    expect(host.runTurn).toHaveBeenCalledWith(
      "session-1",
      "Say hello",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("projects trusted MCP configuration during initialization", async () => {
    const { host, controller } = fixture({
      readMcpConfiguration: vi.fn(async () => ({
        schemaVersion: 1 as const,
        projectRoot: "/project",
        globalConfigPath: "/data/mcp.json",
        servers: [
          {
            id: "linear",
            source: "global",
            transport: "streamable-http",
            url: "https://example.com/mcp",
            headers: {},
            oauth: false,
          } as const,
        ],
      })),
    });

    await controller.initialize();
    expect(host.readMcpConfiguration).toHaveBeenCalledOnce();
    expect(controller.getState().mcpServers).toEqual([
      { id: "linear", source: "global", transport: "streamable-http" },
    ]);

    vi.mocked(host.readMcpConfiguration).mockResolvedValue({
      schemaVersion: 1,
      projectRoot: "/project",
      globalConfigPath: "/data/mcp.json",
      servers: [
        {
          id: "filesystem",
          source: "project",
          transport: "stdio",
          command: "/project/bin/server",
          args: [],
          cwd: "/project",
          env: {},
        },
      ],
    });
    await controller.refreshMcpState();
    expect(controller.getState().mcpServers).toEqual([
      { id: "filesystem", source: "project", transport: "stdio" },
    ]);
  });

  it("updates idle session model and reasoning through the host", async () => {
    const { host, controller } = fixture();
    await controller.initialize();

    await controller.setModel({ providerId: "openai", modelId: "gpt-5.6-sol" });
    await controller.setReasoningEffort("high");

    expect(host.setSessionModel).toHaveBeenCalledWith("session-1", {
      providerId: "openai",
      modelId: "gpt-5.6-sol",
    });
    expect(host.setSessionReasoningEffort).toHaveBeenCalledWith(
      "session-1",
      "high",
    );
    expect(controller.getState()).toMatchObject({
      model: { providerId: "openai", modelId: "gpt-5.6-sol" },
      reasoningEffort: "high",
    });
  });

  it("projects session todo state during activity refresh", async () => {
    const todo = {
      id: "task-1",
      content: "Run tests",
      activeForm: "Running tests",
      status: "in_progress" as const,
    };
    const { controller } = fixture({
      readSessionInteractions: vi.fn(() => ({ todos: [todo] })),
    });
    await controller.initialize();

    expect(controller.getState().todos).toEqual([todo]);
  });

  it("recovers an interrupted restored session before accepting input", async () => {
    const { host, controller } = fixture({
      listSessions: vi.fn(async () => [
        { sessionId: "session-1", updatedAt: 1, state: "running" } as never,
      ]),
      readSession: vi.fn(async () => ({
        record: { runState: { phase: "running" } },
      })) as never,
    });

    await expect(controller.initialize()).resolves.toEqual({
      sessionId: "session-1",
      restored: true,
      recovered: true,
      pendingInteraction: undefined,
    });
    expect(host.recoverInterrupted).toHaveBeenCalledWith("session-1");
    expect(controller.getState().phase).toBe("idle");
  });

  it("projects and resumes a restored pending approval", async () => {
    const pending = interaction();
    const { host, controller } = fixture({
      listSessions: vi.fn(async () => [
        { sessionId: "session-1", updatedAt: 1, state: "suspended" } as never,
      ]),
      readSession: vi.fn(async () => ({
        record: { runState: { phase: "suspended" } },
        pendingInteraction: { request: pending },
      })) as never,
      resumeInteraction: vi.fn(async (_sessionId, decision, options) => {
        options?.onEvent?.(
          turnEvent({
            type: "interaction.resumed",
            interactionId: pending.interactionId,
            decision,
            sessionRevision: "2",
          }),
        );
        return result();
      }),
    });

    await controller.initialize();
    expect(controller.getState()).toMatchObject({
      phase: "awaiting_approval",
      pendingInteraction: { interactionId: "approval-1" },
    });
    await controller.resumeInteraction("allow");
    expect(host.revalidatePendingInteraction).toHaveBeenCalledWith("session-1");
    expect(host.resumeInteraction).toHaveBeenCalledWith(
      "session-1",
      "allow",
      expect.any(Object),
    );
    expect(controller.getState().phase).toBe("idle");
  });

  it("rejects a stale pending approval and clears it from projected state", async () => {
    const pending = interaction();
    const { host, controller } = fixture({
      listSessions: vi.fn(async () => [
        { sessionId: "session-1", updatedAt: 1, state: "suspended" } as never,
      ]),
      readSession: vi.fn(async () => ({
        record: { runState: { phase: "suspended" } },
        pendingInteraction: { request: pending },
      })) as never,
      revalidatePendingInteraction: vi.fn(async () => ({
        ok: false as const,
        reason: "baseline changed",
      })),
    });
    await controller.initialize();

    await expect(controller.resumeInteraction("allow")).rejects.toThrow(
      "Stale proposal rejected: baseline changed",
    );
    expect(host.cancel).toHaveBeenCalledWith(
      "session-1",
      "Stale proposal rejected: baseline changed",
    );
    expect(controller.getState()).toMatchObject({
      phase: "failed",
      pendingInteraction: undefined,
      error: "Stale proposal rejected: baseline changed",
    });
  });

  it("denies a stale pending approval without running allow-only revalidation", async () => {
    const pending = interaction();
    const { host, controller } = fixture({
      listSessions: vi.fn(async () => [
        { sessionId: "session-1", updatedAt: 1, state: "suspended" } as never,
      ]),
      readSession: vi.fn(async () => ({
        record: { runState: { phase: "suspended" } },
        pendingInteraction: { request: pending },
      })) as never,
      revalidatePendingInteraction: vi.fn(async () => ({
        ok: false as const,
        reason: "baseline changed",
      })),
      resumeInteraction: vi.fn(async (_sessionId, decision) => {
        expect(decision).toBe("deny");
        return result();
      }),
    });
    await controller.initialize();

    await expect(controller.resumeInteraction("deny")).resolves.toMatchObject({
      status: "completed",
    });
    expect(host.revalidatePendingInteraction).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe("idle");
  });

  it("cancels a suspended approval to a terminal idle projection", async () => {
    const pending = interaction();
    const { controller } = fixture({
      listSessions: vi.fn(async () => [
        { sessionId: "session-1", updatedAt: 1, state: "suspended" } as never,
      ]),
      readSession: vi.fn(async () => ({
        record: { runState: { phase: "suspended" } },
        pendingInteraction: { request: pending },
      })) as never,
    });
    await controller.initialize();
    await controller.cancel("Denied during restore");

    expect(controller.getState()).toMatchObject({
      phase: "idle",
      pendingInteraction: undefined,
    });
  });

  it("cancels the active turn through both its signal and durable host state", async () => {
    let observedSignal: AbortSignal | undefined;
    const { host, controller } = fixture({
      runTurn: vi.fn(async (_sessionId, _text, options) => {
        observedSignal = options?.signal;
        return await new Promise<AgentTurnResult>((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => resolve(result("cancelled")),
            { once: true },
          );
        });
      }),
    });
    await controller.initialize();
    const running = controller.submit("Keep working");
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await controller.cancel("Stop now");

    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(observedSignal?.aborted).toBe(true);
    expect(host.cancel).toHaveBeenCalledWith("session-1", "Stop now");
    expect(controller.getState().phase).toBe("idle");
  });

  it("leaves cancelling state when durable host cancellation fails", async () => {
    const pending = interaction();
    const { controller } = fixture({
      listSessions: vi.fn(async () => [
        { sessionId: "session-1", updatedAt: 1, state: "suspended" } as never,
      ]),
      readSession: vi.fn(async () => ({
        record: { runState: { phase: "suspended" } },
        pendingInteraction: { request: pending },
      })) as never,
      cancel: vi.fn(async () => {
        throw new Error("persistence unavailable");
      }),
    });
    await controller.initialize();

    await expect(controller.cancel("Stop now")).rejects.toThrow(
      "persistence unavailable",
    );
    expect(controller.getState()).toMatchObject({
      phase: "failed",
      pendingInteraction: undefined,
      error: "persistence unavailable",
    });
  });

  it("serializes prompts and exposes process, child, and approval activity", async () => {
    const command = { commandId: "command-1", state: "running" } as never;
    const child = {
      childSessionId: "child-1",
      lifecycle: "running",
    } as never;
    const approval = {
      childSessionId: "child-2",
      lifecycle: "awaiting_approval",
      approval: { interactionId: "approval-2" },
    } as never;
    const observation = { record: command, output: [] } as never;
    const { host, controller } = fixture({
      listCommands: vi.fn(() => [command]),
      listBackgroundAgents: vi.fn(() => [child, approval]),
      listBackgroundApprovals: vi.fn(() => [approval]),
      observeCommand: vi.fn(() => observation),
      stopCommand: vi.fn(async () => command),
      steerBackgroundAgent: vi.fn(async () => ({ status: "queued" })) as never,
      stopBackgroundAgent: vi.fn(async () => child) as never,
    });
    await controller.initialize();

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = controller.runPrompt(
      () =>
        new Promise<void>((resolve) => {
          order.push("first:start");
          releaseFirst = () => {
            order.push("first:end");
            resolve();
          };
        }),
    );
    const second = controller.runPrompt(async () => {
      order.push("second");
    });
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    expect(order).toEqual(["first:start"]);
    releaseFirst!();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);

    const refreshed = controller.refreshActivity();
    expect(refreshed).toMatchObject({
      commands: [{ commandId: "command-1" }],
      backgroundAgents: [
        { childSessionId: "child-1" },
        { childSessionId: "child-2" },
      ],
      backgroundApprovals: [{ childSessionId: "child-2" }],
    });
    expect(controller.refreshActivity().revision).toBe(refreshed.revision);
    expect(controller.observeCommand("command-1")).toMatchObject({
      record: { commandId: "command-1", state: "running" },
      output: [],
    });
    await controller.stopCommand("command-1");
    await controller.steerBackgroundAgent("child-1", "Wrap up");
    await controller.stopBackgroundAgent("child-1");
    await controller.respondToBackgroundApproval(
      "child-2",
      "approval-2",
      "deny",
    );
    expect(host.observeCommand).toHaveBeenCalledWith(
      "command-1",
      { sessionId: "session-1" },
      undefined,
    );
    expect(host.respondToBackgroundApproval).toHaveBeenCalledWith({
      callerSessionId: "session-1",
      childSessionId: "child-2",
      interactionId: "approval-2",
      decision: "deny",
    });
  });

  it("selects and hydrates an existing session without exposing the host", async () => {
    const { host, controller } = fixture({
      createSession: vi.fn(async () => ({ sessionId: "session-1" })),
      readSession: vi.fn(async (sessionId: string) => ({
        record: {
          messages: [
            { role: "assistant", content: `History for ${sessionId}` },
          ],
          selectedModel: { providerId: "fake", modelId: "model" },
          runState: { phase: "idle" },
        },
      })) as never,
    });
    await controller.initialize();

    await expect(controller.selectSession("session-2")).resolves.toBe(
      "session-2",
    );

    expect(host.readSession).toHaveBeenCalledWith("session-2");
    expect(controller.getState()).toMatchObject({
      sessionId: "session-2",
      phase: "idle",
      transcript: [
        expect.objectContaining({
          role: "assistant",
          text: "History for session-2",
        }),
      ],
    });
  });

  it("returns stable initialization and rejects session switching during a turn", async () => {
    let settleTurn: ((value: AgentTurnResult) => void) | undefined;
    const { controller } = fixture({
      runTurn: vi.fn(
        async () =>
          await new Promise<AgentTurnResult>((resolve) => {
            settleTurn = resolve;
          }),
      ),
    });
    const initialized = await controller.initialize();
    await expect(controller.initialize()).resolves.toBe(initialized);
    const running = controller.submit("Keep working");
    await vi.waitFor(() => expect(settleTurn).toBeDefined());

    await expect(controller.newSession()).rejects.toThrow(
      "Cannot switch sessions during an active turn",
    );
    await expect(controller.selectSession("session-2")).rejects.toThrow(
      "Cannot switch sessions during an active turn",
    );
    expect(controller.getState().sessionId).toBe("session-1");
    settleTurn!(result());
    await running;
  });

  it("aborts serialized prompts and waits for an active turn before closing", async () => {
    let promptSignal: AbortSignal | undefined;
    let turnSignal: AbortSignal | undefined;
    const { host, controller } = fixture({
      runTurn: vi.fn(async (_sessionId, _text, options) => {
        turnSignal = options?.signal;
        return await new Promise<AgentTurnResult>((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => resolve(result("cancelled")),
            { once: true },
          );
        });
      }),
    });
    await controller.initialize();
    const prompt = controller.runPrompt(
      async (signal) =>
        await new Promise<void>((_resolve, reject) => {
          promptSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(new Error("prompt aborted")),
            { once: true },
          );
        }),
    );
    const running = controller.submit("Keep working");
    await vi.waitFor(() => {
      expect(promptSignal).toBeDefined();
      expect(turnSignal).toBeDefined();
    });

    await controller.close();
    await expect(prompt).rejects.toThrow("prompt aborted");
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(promptSignal?.aborted).toBe(true);
    expect(turnSignal?.aborted).toBe(true);
    expect(host.cancel).toHaveBeenCalledWith(
      "session-1",
      "Session controller closed",
    );
    expect(controller.getState().phase).toBe("closed");
    await expect(controller.runPrompt(async () => undefined)).rejects.toThrow(
      "Session controller is closed",
    );
  });

  it("stops active children before switching to a new session and closes once", async () => {
    const activeChild = {
      childSessionId: "child-1",
      lifecycle: "running",
    } as never;
    const createSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "session-1" })
      .mockResolvedValueOnce({ sessionId: "session-2" });
    const { host, controller } = fixture({
      createSession,
      listBackgroundAgents: vi.fn(() => [activeChild]),
      stopBackgroundAgent: vi.fn(async () => activeChild) as never,
    });
    await controller.initialize();

    await expect(controller.newSession()).resolves.toBe("session-2");
    expect(host.stopBackgroundAgent).toHaveBeenCalledWith({
      callerSessionId: "session-1",
      childSessionId: "child-1",
      reason: "Parent started a new session",
    });
    await controller.close();
    await controller.close();
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe("closed");
  });
});
