import { TODO_WRITE_INPUT_SCHEMA, todoTool } from "@agentlink/core/todo-tool";
import { describe, expect, it, vi } from "vitest";

import { SET_TASK_STATUS_TOOL } from "@agentlink/core/interaction-tools";
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
  it("asks VS Code's questions[] through the host callback", async () => {
    const askQuestions = vi.fn(async () => ({
      answers: { decision: "Ship it", name: "v2" },
      notes: { decision: "after review" },
    }));
    const tools = createWorkspaceSessionInteractionTools({ askQuestions });
    const ask = (await tools.resolveTools(discovery)).find(
      (tool) => tool.definition.name === "ask_user",
    )!;
    const schema = JSON.stringify(ask.definition.input_schema);
    expect(schema).toContain('"questions"');
    expect(schema).not.toContain("modeSwitch");
    expect(ask.definition.description).not.toContain("modeSwitch");
    expect(ask.definition.description).not.toContain("coordinator");

    const result = await ask.execute(
      {
        context: "Release",
        questions: [
          {
            id: "decision",
            type: "multiple_choice",
            question: "What next?",
            context: " Pick one ",
            options: ["Ship it", "Wait"],
            recommended: "Ship it",
            modeSwitch: { Wait: "architect" },
          },
          { id: "name", type: "text", question: "Version name?" },
        ],
      },
      execution,
    );
    const payload = {
      context: "Release",
      responses: [
        {
          question: "What next?",
          answer: "Ship it",
          context: "Pick one",
          note: "after review",
        },
        { question: "Version name?", answer: "v2" },
      ],
    };
    expect(result).toEqual({
      modelContent: JSON.stringify(payload),
      displayContent: payload,
    });
    // modeSwitch is dropped before the host sees the question.
    expect(askQuestions).toHaveBeenCalledWith(
      {
        context: "Release",
        questions: [
          {
            id: "decision",
            type: "multiple_choice",
            question: "What next?",
            context: "Pick one",
            options: ["Ship it", "Wait"],
            recommended: "Ship it",
          },
          {
            id: "name",
            type: "text",
            question: "Version name?",
            context: undefined,
          },
        ],
      },
      { sessionId: "session-1", signal: execution.signal },
    );
  });

  it("rejects ask_user calls VS Code rejects without asking", async () => {
    const askQuestions = vi.fn();
    const tools = createWorkspaceSessionInteractionTools({ askQuestions });
    const ask = (await tools.resolveTools(discovery)).find(
      (tool) => tool.definition.name === "ask_user",
    )!;
    await expect(
      ask.execute(
        { questions: [{ id: "q", type: "text", question: "Name?" }] },
        execution,
      ),
    ).resolves.toMatchObject({ isError: true });
    expect(askQuestions).not.toHaveBeenCalled();
  });

  it("propagates question cancellation so the turn stops", async () => {
    const cancelled = new Error("Question cancelled by user");
    cancelled.name = "AbortError";
    const tools = createWorkspaceSessionInteractionTools({
      askQuestions: vi.fn(async () => {
        throw cancelled;
      }),
    });
    const ask = (await tools.resolveTools(discovery)).find(
      (tool) => tool.definition.name === "ask_user",
    )!;

    await expect(
      ask.execute(
        {
          context: "Naming",
          questions: [{ id: "decision", type: "text", question: "What next?" }],
        },
        execution,
      ),
    ).rejects.toBe(cancelled);
  });

  it("offers no ask_user without a question callback", async () => {
    const tools = createWorkspaceSessionInteractionTools({});
    expect(
      (await tools.resolveTools(discovery)).map((tool) => tool.definition.name),
    ).toEqual(["todo_write"]);
  });

  it("offers set_task_status only when the host opts in", async () => {
    const names = async (finalStatus?: boolean) =>
      (
        await createWorkspaceSessionInteractionTools({
          finalStatus,
        }).resolveTools(discovery)
      ).map((tool) => tool.definition.name);
    expect(await names()).toEqual(["todo_write"]);
    expect(await names(true)).toEqual(["todo_write", "set_task_status"]);
  });

  it("sets VS Code's final status and ends the turn", async () => {
    const onTodosChanged = vi.fn();
    const tools = createWorkspaceSessionInteractionTools({
      finalStatus: true,
      onTodosChanged,
    });
    const resolved = await tools.resolveTools(discovery);
    const find = (name: string) =>
      resolved.find((tool) => tool.definition.name === name)!;
    const setStatus = find("set_task_status");
    expect(setStatus.definition).toMatchObject({
      name: "set_task_status",
      description: SET_TASK_STATUS_TOOL.description,
      input_schema: SET_TASK_STATUS_TOOL.input_schema,
    });
    await find("todo_write").execute(
      {
        todos: [
          {
            id: "a",
            content: "Build",
            activeForm: "Building",
            status: "in_progress",
            children: [
              {
                id: "a1",
                content: "Test",
                activeForm: "Testing",
                status: "pending",
              },
            ],
          },
        ],
      },
      execution,
    );
    const done = [
      {
        id: "a",
        content: "Build",
        activeForm: "Building",
        status: "completed",
        children: [
          {
            id: "a1",
            content: "Test",
            activeForm: "Testing",
            status: "completed",
          },
        ],
      },
    ];
    await expect(
      setStatus.execute(
        {
          status: "completed",
          summary: "  Built it.  ",
          completeTodos: true,
          continueLabel: "Ship",
          continuePrompt: "Ship the build",
        },
        execution,
      ),
    ).resolves.toEqual({
      modelContent: JSON.stringify({ ok: true, completedTodos: 1 }),
      displayContent: {
        finalStatus: {
          status: "completed",
          source: "tool",
          summary: "Built it.",
          continueAction: { label: "Ship", prompt: "Ship the build" },
        },
        todos: done,
      },
      endTurn: { finalText: "Built it." },
    });
    expect(tools.snapshot("session-1").todos).toEqual(done);
    expect(onTodosChanged).toHaveBeenLastCalledWith("session-1", done);
  });

  it("ignores completeTodos unless the status is completed, as VS Code does", async () => {
    const tools = createWorkspaceSessionInteractionTools({ finalStatus: true });
    const setStatus = (await tools.resolveTools(discovery)).find(
      (tool) => tool.definition.name === "set_task_status",
    )!;
    await expect(
      setStatus.execute(
        { status: "blocked", summary: "Need a key.", completeTodos: true },
        execution,
      ),
    ).resolves.toMatchObject({
      modelContent: JSON.stringify({
        ok: true,
        completeTodosIgnored:
          "completeTodos only applies when status is 'completed'",
      }),
      endTurn: { finalText: "Need a key." },
    });
    // The schema's enum rejects an unknown status before the handler runs.
    await expect(
      setStatus.execute({ status: "done" }, execution),
    ).rejects.toThrow(/set_task_status/u);
  });

  it("replaces and snapshots session-scoped todo state", async () => {
    const onTodosChanged = vi.fn();
    const tools = createWorkspaceSessionInteractionTools({
      askQuestions: vi.fn(),
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
