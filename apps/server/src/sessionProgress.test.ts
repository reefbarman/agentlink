import {
  AUTO_CONTINUE_PROMPT,
  TurnProgress,
  hasUnfinishedTodos,
  shouldAutoContinue,
  todosFromToolResult,
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

describe("session progress", () => {
  it("uses VS Code's Auto Continue prompt", () => {
    expect(AUTO_CONTINUE_PROMPT).toMatch(/TODO list still has unfinished/);
  });

  it("reads the list a todo_write call set, and nothing else", () => {
    const todos = [todo("a", "completed"), todo("b", "pending")];
    expect(todosFromToolResult("todo_write", { todos })).toEqual(todos);
    expect(todosFromToolResult("write_file", { todos })).toBeUndefined();
    expect(
      todosFromToolResult("todo_write", { todos: [{ id: "x" }] }),
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

    const work = new TurnProgress();
    work.observe(completed("read_file"));
    work.observe(
      completed("todo_write", { todos: [todo("a", "in_progress")] }),
    );
    expect(work.madeProgress).toBe(true);
    expect(work.todos).toEqual([todo("a", "in_progress")]);
  });

  it("continues only a completed turn that made progress with work left", () => {
    const left = [todo("a", "pending")];
    expect(
      shouldAutoContinue({ completed: true, madeProgress: true, todos: left }),
    ).toBe(true);
    expect(
      shouldAutoContinue({ completed: false, madeProgress: true, todos: left }),
    ).toBe(false);
    expect(
      shouldAutoContinue({ completed: true, madeProgress: false, todos: left }),
    ).toBe(false);
    expect(
      shouldAutoContinue({
        completed: true,
        madeProgress: true,
        todos: [todo("a", "completed")],
      }),
    ).toBe(false);
  });
});
