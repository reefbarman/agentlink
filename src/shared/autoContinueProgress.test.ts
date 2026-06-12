import { describe, expect, it } from "vitest";
import { isProgressToolName, turnMadeProgress } from "./autoContinueProgress";

describe("isProgressToolName", () => {
  it("counts mutating built-in tools as progress", () => {
    expect(isProgressToolName("apply_diff")).toBe(true);
    expect(isProgressToolName("write_file")).toBe(true);
    expect(isProgressToolName("execute_command")).toBe(true);
    expect(isProgressToolName("todo_write")).toBe(true);
  });

  it("does not count read-only or final-status tools as progress", () => {
    expect(isProgressToolName("read_file")).toBe(false);
    expect(isProgressToolName("get_context")).toBe(false);
    expect(isProgressToolName("set_task_status")).toBe(false);
    expect(isProgressToolName("ask_user")).toBe(false);
  });

  it("counts direct MCP tool names conservatively as progress", () => {
    expect(isProgressToolName("linear__create_issue")).toBe(true);
    expect(isProgressToolName("chrome-devtools__click")).toBe(true);
  });
});

describe("turnMadeProgress", () => {
  it("scans assistant messages after the auto-continue user message", () => {
    expect(
      turnMadeProgress(
        [
          { id: "user-1", role: "user" },
          {
            id: "assistant-1",
            role: "assistant",
            blocks: [{ type: "tool_call", name: "read_file" }],
          },
          { id: "auto-user", role: "user" },
          {
            id: "assistant-2",
            role: "assistant",
            blocks: [{ type: "tool_call", name: "apply_diff" }],
          },
        ],
        "auto-user",
      ),
    ).toBe(true);
  });

  it("does not count read-only work after the auto-continue user message", () => {
    expect(
      turnMadeProgress(
        [
          { id: "auto-user", role: "user" },
          {
            id: "assistant-1",
            role: "assistant",
            blocks: [
              { type: "tool_call", name: "read_file" },
              { type: "tool_call", name: "set_task_status" },
            ],
          },
        ],
        "auto-user",
      ),
    ).toBe(false);
  });

  it("counts progress before an engine-injected user continuation in the same send", () => {
    expect(
      turnMadeProgress(
        [
          { id: "auto-user", role: "user" },
          {
            id: "assistant-1",
            role: "assistant",
            blocks: [{ type: "tool_call", name: "write_file" }],
          },
          {
            id: "engine-user",
            role: "user",
          },
          {
            id: "assistant-2",
            role: "assistant",
            blocks: [{ type: "tool_call", name: "set_task_status" }],
          },
        ],
        "auto-user",
      ),
    ).toBe(true);
  });

  it("counts spawned background agents as progress", () => {
    expect(
      turnMadeProgress(
        [
          { id: "auto-user", role: "user" },
          {
            id: "assistant-1",
            role: "assistant",
            blocks: [{ type: "bg_agent" }],
          },
        ],
        "auto-user",
      ),
    ).toBe(true);
  });

  it("fails open when the boundary message is missing", () => {
    expect(
      turnMadeProgress(
        [
          {
            id: "assistant-1",
            role: "assistant",
            blocks: [{ type: "tool_call", name: "apply_diff" }],
          },
        ],
        "missing",
      ),
    ).toBe(true);
  });
});
