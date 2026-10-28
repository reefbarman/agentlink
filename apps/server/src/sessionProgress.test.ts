import {
  AUTO_CONTINUE_PROMPT,
  TurnProgress,
  finalStatusFromToolResult,
  hasUnfinishedTodos,
  shouldAutoContinue,
  todosFromToolResult,
  withFinalStatusHints,
} from "./sessionProgress.js";
import { describe, expect, it } from "vitest";

import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import type { TodoItem } from "@agentlink/protocol/chat-transcript";

const completed = (toolName: string, displayContent?: unknown) =>
  ({
    type: "tool.completed",
    toolCallId: "c",
    toolName,
    displayContent,
  }) as unknown as EmbeddedAgentTurnEvent;

const todo = (
  id: string,
  status: "pending" | "in_progress" | "completed",
  children?: TodoItem[],
): TodoItem => ({
  id,
  content: id,
  activeForm: id,
  status,
  ...(children ? { children } : {}),
});

const finalStatus = {
  status: "completed",
  source: "tool",
  summary: "Done.",
} as const;

describe("session progress", () => {
  it("uses VS Code's Auto Continue prompt", () => {
    expect(AUTO_CONTINUE_PROMPT).toMatch(/TODO list still has unfinished/);
  });

  it("reads the list a todo_write or completing set_task_status call set, and nothing else", () => {
    const todos = [todo("a", "completed"), todo("b", "pending")];
    expect(todosFromToolResult("todo_write", { todos })).toEqual(todos);
    expect(
      todosFromToolResult("set_task_status", { finalStatus, todos }),
    ).toEqual(todos);
    expect(
      todosFromToolResult("set_task_status", { finalStatus }),
    ).toBeUndefined();
    expect(todosFromToolResult("write_file", { todos })).toBeUndefined();
    expect(
      todosFromToolResult("todo_write", { todos: [{ id: "x" }] }),
    ).toBeUndefined();
  });

  it("reads the final status a set_task_status call set", () => {
    expect(
      finalStatusFromToolResult("set_task_status", { finalStatus }),
    ).toEqual(finalStatus);
    expect(
      finalStatusFromToolResult("set_task_status", {
        finalStatus: { status: "done" },
      }),
    ).toBeUndefined();
    expect(
      finalStatusFromToolResult("todo_write", { finalStatus }),
    ).toBeUndefined();
  });

  it("finds unfinished items at any depth", () => {
    expect(hasUnfinishedTodos([])).toBe(false);
    expect(hasUnfinishedTodos([todo("a", "completed")])).toBe(false);
    expect(
      hasUnfinishedTodos([todo("a", "completed", [todo("a1", "in_progress")])]),
    ).toBe(true);
  });

  it("counts writes, commands and todo updates as progress, not reads", () => {
    const reads = new TurnProgress();
    reads.observe(completed("read_file"));
    reads.observe(completed("search_files"));
    expect(reads.madeProgress).toBe(false);
    expect(reads.todos).toBeUndefined();
    expect(reads.finalStatus).toBeUndefined();

    const work = new TurnProgress();
    work.observe(completed("read_file"));
    work.observe(
      completed("todo_write", { todos: [todo("a", "in_progress")] }),
    );
    expect(work.madeProgress).toBe(true);
    expect(work.todos).toEqual([todo("a", "in_progress")]);
    work.observe(
      completed("set_task_status", {
        finalStatus,
        todos: [todo("a", "completed")],
      }),
    );
    expect(work.finalStatus).toEqual(finalStatus);
    expect(work.todos).toEqual([todo("a", "completed")]);
  });

  it("continues only a completed turn that made progress with work left and no final status", () => {
    const left = [todo("a", "pending")];
    const base = { completed: true, madeProgress: true, finalStatus: false };
    expect(shouldAutoContinue({ ...base, todos: left })).toBe(true);
    expect(shouldAutoContinue({ ...base, completed: false, todos: left })).toBe(
      false,
    );
    expect(
      shouldAutoContinue({ ...base, madeProgress: false, todos: left }),
    ).toBe(false);
    // VS Code: an explicit final marker ends Auto Continue.
    expect(
      shouldAutoContinue({ ...base, finalStatus: true, todos: left }),
    ).toBe(false);
    expect(
      shouldAutoContinue({ ...base, todos: [todo("a", "completed")] }),
    ).toBe(false);
  });

  it("restores each set_task_status card as VS Code's uiHint", () => {
    const call = {
      role: "assistant",
      content: [
        { type: "text", text: "Wrapping up." },
        {
          type: "tool_use",
          id: "s",
          name: "set_task_status",
          input: {
            status: "blocked",
            summary: "Need a key.",
            continueLabel: "Retry",
            continuePrompt: "Try again",
          },
        },
      ],
    };
    const user = { role: "user", content: "hi" };
    expect(withFinalStatusHints([user, call])).toEqual([
      user,
      {
        ...call,
        uiHint: {
          finalMarker: {
            status: "blocked",
            source: "tool",
            summary: "Need a key.",
            continueAction: { label: "Retry", prompt: "Try again" },
          },
        },
      },
    ]);
  });
});
