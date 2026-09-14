import { describe, expect, it, vi } from "vitest";

import { createWorkspaceSessionInteractionTools } from "./sessionInteractionTools.js";

const discovery = {
  principal: { tenantId: "local", subjectId: "project" },
  sessionId: "session-1",
  turnId: "turn-1",
  input: { text: "test", attachments: undefined },
} as const;

const execution = {
  principal: discovery.principal,
  sessionId: discovery.sessionId,
  turnId: discovery.turnId,
  model: {} as never,
  signal: new AbortController().signal,
} as const;

describe("workspace session interaction tools", () => {
  it("asks a structured question through the host callback", async () => {
    const askQuestion = vi.fn(async () => "Ship it");
    const tools = createWorkspaceSessionInteractionTools({ askQuestion });
    const ask = (await tools.resolveTools(discovery)).find(
      (tool) => tool.definition.name === "ask_user",
    )!;

    await expect(
      ask.execute(
        {
          id: "decision",
          kind: "multiple_choice",
          question: "What next?",
          options: ["Ship it", "Wait"],
          recommended: "Ship it",
        },
        execution,
      ),
    ).resolves.toMatchObject({
      modelContent: JSON.stringify({ id: "decision", answer: "Ship it" }),
      displayContent: { id: "decision", answer: "Ship it" },
    });
    expect(askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision",
        kind: "multiple_choice",
        options: ["Ship it", "Wait"],
      }),
      { sessionId: "session-1", signal: execution.signal },
    );
  });

  it("propagates question cancellation so the turn stops", async () => {
    const cancelled = new Error("Question cancelled by user");
    cancelled.name = "AbortError";
    const tools = createWorkspaceSessionInteractionTools({
      askQuestion: vi.fn(async () => {
        throw cancelled;
      }),
    });
    const ask = (await tools.resolveTools(discovery)).find(
      (tool) => tool.definition.name === "ask_user",
    )!;

    await expect(
      ask.execute(
        {
          id: "decision",
          kind: "text",
          question: "What next?",
        },
        execution,
      ),
    ).rejects.toBe(cancelled);
  });

  it("replaces and snapshots session-scoped todo state", async () => {
    const onTodosChanged = vi.fn();
    const tools = createWorkspaceSessionInteractionTools({
      askQuestion: vi.fn(),
      onTodosChanged,
    });
    const todoWrite = (await tools.resolveTools(discovery)).find(
      (tool) => tool.definition.name === "todo_write",
    )!;
    const todos = [
      {
        id: "task-1",
        content: "Run tests",
        activeForm: "Running tests",
        status: "in_progress",
      },
    ];

    await todoWrite.execute({ todos }, execution);
    expect(tools.snapshot("session-1").todos).toEqual(todos);
    expect(tools.snapshot("other-session").todos).toEqual([]);
    expect(onTodosChanged).toHaveBeenCalledWith("session-1", todos);
  });
});
