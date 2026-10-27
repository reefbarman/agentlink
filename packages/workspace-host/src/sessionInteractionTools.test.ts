import { TODO_WRITE_INPUT_SCHEMA, todoTool } from "@agentlink/core/todo-tool";
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

    expect(todoWrite.definition).toMatchObject({
      name: "todo_write",
      description: todoTool.description,
      input_schema: TODO_WRITE_INPUT_SCHEMA,
    });
    await expect(todoWrite.execute({ todos }, execution)).resolves.toEqual({
      modelContent: "Updated: 0/1 complete, 1 in progress, 0 pending",
      displayContent: { todos },
    });
    expect(tools.snapshot("session-1").todos).toEqual(todos);
    expect(tools.snapshot("other-session").todos).toEqual([]);
    expect(onTodosChanged).toHaveBeenCalledWith("session-1", todos);
  });

  it("rebuilds a session's todos from its transcript once", async () => {
    const written = [
      { id: "a", content: "Plan", activeForm: "Planning", status: "completed" },
      { id: "b", content: "Build", activeForm: "Building", status: "pending" },
    ];
    const readTranscript = vi.fn(async () => [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "call-1",
            name: "todo_write",
            input: { todos: written },
          },
          {
            type: "tool_use" as const,
            id: "call-2",
            name: "set_task_status",
            input: { status: "completed", completeTodos: true },
          },
        ],
      },
    ]);
    const tools = createWorkspaceSessionInteractionTools({ readTranscript });
    await tools.resolveTools(discovery);
    await tools.resolveTools({ ...discovery, turnId: "turn-2" });
    expect(readTranscript).toHaveBeenCalledTimes(1);
    expect(tools.snapshot("session-1").todos).toEqual(
      written.map((todo) => ({ ...todo, status: "completed" })),
    );
    // A list the model already wrote in this process is never replaced.
    tools.restore("session-1", []);
    expect(tools.snapshot("session-1").todos).toHaveLength(2);
  });
});
