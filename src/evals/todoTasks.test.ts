import { describe, expect, it } from "vitest";
import { translateCodexMessages } from "@agentlink/core/codex";
import { translateOpenAiCompatibleMessages } from "@agentlink/core/openai-compatible";
import { getAgentTools } from "../agent/toolAdapter.js";
import { handleTodoWrite, type TodoToolInput } from "../agent/todoTool.js";
import {
  TODO_PROBES,
  gradeTodoProbe,
  script,
  type TodoProbe,
} from "./todoTasks.js";

const probe = (expect: TodoProbe["expect"]): TodoProbe => ({
  id: "p",
  intent: "i",
  mode: "code",
  messages: script([{ user: "u" }]),
  expect,
});

const todos = (...statuses: [string, string][]) => ({
  name: "todo_write",
  input: {
    todos: statuses.map(([id, status]) => ({
      id,
      content: id,
      activeForm: id,
      status,
    })),
  },
});

describe("gradeTodoProbe", () => {
  it("passes a required list batched with a real action", () => {
    const grade = gradeTodoProbe(probe({ todo: "required", batched: true }), [
      todos(["a", "in_progress"]),
      { name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(grade).toEqual({
      pass: true,
      tools: ["todo_write", "read_file"],
      reasons: [],
      todoCalls: 1,
      todoOnly: false,
    });
  });

  it("fails a TODO-only reply when the update must be batched", () => {
    const grade = gradeTodoProbe(probe({ todo: "required", batched: true }), [
      todos(["a", "in_progress"]),
    ]);
    expect(grade.pass).toBe(false);
    expect(grade.todoOnly).toBe(true);
    expect(grade.reasons).toEqual([
      "todo_write was the only call; expected it batched with the next action",
    ]);
  });

  it("fails a missing required list and a forbidden one", () => {
    expect(
      gradeTodoProbe(probe({ todo: "required" }), [
        { name: "read_file", input: {} },
      ]).reasons,
    ).toEqual(["no todo_write; expected the list to be started or updated"]);
    expect(
      gradeTodoProbe(probe({ todo: "forbidden" }), [
        todos(["a", "in_progress"]),
        { name: "read_file", input: {} },
      ]).reasons,
    ).toEqual(["called todo_write 1x; expected no list change"]);
  });

  it("checks statuses on the last todo_write, unwrapping call_native_tool", () => {
    const expectation = probe({
      todo: "required",
      statuses: { a: "completed", b: "in_progress" },
    });
    const native = todos(["a", "completed"], ["b", "in_progress"]);
    expect(
      gradeTodoProbe(expectation, [
        todos(["a", "in_progress"], ["b", "pending"]),
        {
          name: "call_native_tool",
          input: { name: "todo_write", input: native.input },
        },
      ]).pass,
    ).toBe(true);
    expect(
      gradeTodoProbe(expectation, [todos(["a", "completed"], ["b", "pending"])])
        .reasons,
    ).toEqual(['todo "b" is pending; expected in_progress']);
    expect(
      gradeTodoProbe(expectation, [todos(["b", "in_progress"])]).reasons,
    ).toEqual(['todo "a" is missing; expected completed']);
  });

  it("requires completeTodos on a final status, without requiring the call", () => {
    const expectation = probe({ todo: "forbidden", completeTodos: true });
    expect(
      gradeTodoProbe(expectation, [
        {
          name: "set_task_status",
          input: { status: "completed", completeTodos: true },
        },
      ]).pass,
    ).toBe(true);
    expect(
      gradeTodoProbe(expectation, [
        { name: "set_task_status", input: { status: "completed" } },
      ]).reasons,
    ).toEqual([
      'set_task_status {"status":"completed"}; expected completed with completeTodos: true',
    ]);
    expect(
      gradeTodoProbe(expectation, [
        todos(["a", "completed"]),
        {
          name: "set_task_status",
          input: { status: "completed", completeTodos: true },
        },
      ]).reasons,
    ).toEqual(["called todo_write 1x; expected no list change"]);
    expect(
      gradeTodoProbe(expectation, [{ name: "execute_command", input: {} }])
        .pass,
    ).toBe(true);
    expect(
      gradeTodoProbe(probe({ todo: "forbidden", anyOf: ["read_file"] }), [])
        .reasons,
    ).toEqual(["called no tools; expected one of read_file"]);
  });
});

describe("script", () => {
  it("pairs each scripted call with its result and appends interjections", () => {
    const messages = script([
      { user: "start" },
      {
        assistant: "reading",
        calls: [
          { name: "read_file", input: { path: "a" }, result: "A" },
          { name: "read_file", input: { path: "b" }, result: "B" },
        ],
      },
      { user: "also do c" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          {
            type: "tool_use",
            id: "call_eval_1",
            name: "read_file",
            input: { path: "a" },
          },
          {
            type: "tool_use",
            id: "call_eval_2",
            name: "read_file",
            input: { path: "b" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_eval_1", content: "A" },
          { type: "tool_result", tool_use_id: "call_eval_2", content: "B" },
          { type: "text", text: "also do c" },
        ],
      },
    ]);
  });
});

describe("TODO_PROBES", () => {
  const known = new Set(
    getAgentTools(
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      ["search", "fetch"],
    ).map((tool) => tool.name),
  );
  known.add("todo_write");

  it("has unique ids and covers both list and no-list decisions", () => {
    const ids = TODO_PROBES.map((todoProbe) => todoProbe.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(TODO_PROBES.map((p) => p.expect.todo));
    expect(kinds).toEqual(new Set(["required", "forbidden"]));
  });

  it.each(TODO_PROBES.map((todoProbe) => [todoProbe.id, todoProbe]))(
    "%s is a valid scripted conversation",
    (_id, todoProbe) => {
      const { messages, expect: expectation } = todoProbe;
      expect(messages[0]?.role).toBe("user");
      expect(messages.at(-1)?.role).toBe("user");

      for (const name of expectation.anyOf ?? []) {
        expect(known).toContain(name);
      }

      let lastTodoIds: string[] = [];
      for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
          continue;
        }
        for (const block of message.content) {
          if (block.type !== "tool_use") continue;
          expect(known, `${todoProbe.id} scripts ${block.name}`).toContain(
            block.name,
          );
          if (block.name === "todo_write") {
            // Scripted lists must be lists the real tool accepts without
            // corrective guidance, or the probe teaches the wrong thing.
            const { content, todos: accepted } = handleTodoWrite(
              block.input as unknown as TodoToolInput,
            );
            expect(content).toMatch(/^Updated: [^.]*pending$/);
            lastTodoIds = accepted.map((todo) => todo.id);
          }
        }
      }
      for (const id of Object.keys(expectation.statuses ?? {})) {
        expect(lastTodoIds, `${todoProbe.id} status for ${id}`).toContain(id);
      }

      // Both eval transports must accept the conversation.
      expect(() => translateCodexMessages(messages)).not.toThrow();
      expect(() =>
        translateOpenAiCompatibleMessages({
          providerId: "openai-compatible:eval",
          messages,
          supportsImages: false,
        }),
      ).not.toThrow();
    },
  );
});
