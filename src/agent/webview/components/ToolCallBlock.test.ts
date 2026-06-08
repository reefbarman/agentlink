import { describe, expect, it } from "vitest";
import {
  formatToolFileDisplayPath,
  getToolCallVisualState,
} from "./ToolCallBlock";

describe("formatToolFileDisplayPath", () => {
  it("returns an empty display for empty paths", () => {
    expect(formatToolFileDisplayPath("")).toBe("");
  });

  it("leaves short workspace-relative paths unchanged", () => {
    expect(formatToolFileDisplayPath("src/App.tsx")).toBe("src/App.tsx");
  });

  it("compacts long workspace-relative paths", () => {
    expect(formatToolFileDisplayPath("src/agent/webview/App.tsx")).toBe(
      ".../webview/App.tsx",
    );
  });

  it("preserves explicit relative paths", () => {
    expect(formatToolFileDisplayPath(".")).toBe(".");
    expect(formatToolFileDisplayPath("./src/agent/webview/App.tsx")).toBe(
      "./src/agent/webview/App.tsx",
    );
    expect(formatToolFileDisplayPath("..")).toBe("..");
    expect(formatToolFileDisplayPath("../other-project/src/App.tsx")).toBe(
      "../other-project/src/App.tsx",
    );
  });

  it("preserves absolute paths", () => {
    expect(formatToolFileDisplayPath("/tmp/agentlink-output/full.log")).toBe(
      "/tmp/agentlink-output/full.log",
    );
    expect(formatToolFileDisplayPath("C:/Users/tristan/output/full.log")).toBe(
      "C:/Users/tristan/output/full.log",
    );
    expect(
      formatToolFileDisplayPath("C:\\Users\\tristan\\output\\full.log"),
    ).toBe("C:\\Users\\tristan\\output\\full.log");
    expect(
      formatToolFileDisplayPath("\\\\server\\share\\output\\full.log"),
    ).toBe("\\\\server\\share\\output\\full.log");
  });
});

describe("getToolCallVisualState", () => {
  it("marks incomplete tool calls as running", () => {
    const state = getToolCallVisualState({
      name: "apply_diff",
      complete: false,
      result: "",
    });

    expect(state).toEqual({
      statusClass: "tool-running",
      statusIconClass: "codicon-loading codicon-modifier-spin",
      cmdExitBadge: null,
    });
  });

  it("marks error-shaped payloads as error", () => {
    const state = getToolCallVisualState({
      name: "apply_diff",
      complete: true,
      result: JSON.stringify({
        error: "All search/replace blocks failed",
        failed_blocks: ["Block 0: Search content not found"],
        path: "src/agent/webview/App.tsx",
      }),
    });

    expect(state.statusClass).toBe("tool-error");
    expect(state.statusIconClass).toBe("codicon-error");
  });

  it("marks execute_command non-zero exit as warning with badge", () => {
    const state = getToolCallVisualState({
      name: "execute_command",
      complete: true,
      result: JSON.stringify({ exit_code: 2, output: "failed" }),
    });

    expect(state.statusClass).toBe("tool-warning");
    expect(state.statusIconClass).toBe("codicon-warning");
    expect(state.cmdExitBadge).toBe("2");
  });

  it("does not warn on execute_command exit_code 0", () => {
    const state = getToolCallVisualState({
      name: "execute_command",
      complete: true,
      result: JSON.stringify({ exit_code: 0, output: "ok" }),
    });

    expect(state.statusClass).toBe("tool-success");
    expect(state.statusIconClass).toBe("codicon-check");
    expect(state.cmdExitBadge).toBe(null);
  });

  it("marks partial results as warning", () => {
    const state = getToolCallVisualState({
      name: "apply_diff",
      complete: true,
      result: JSON.stringify({
        status: "accepted",
        partial: true,
        failed_blocks: [1],
      }),
    });

    expect(state.statusClass).toBe("tool-warning");
    expect(state.statusIconClass).toBe("codicon-warning");
  });

  it("marks stopped status as warning", () => {
    const state = getToolCallVisualState({
      name: "write_file",
      complete: true,
      result: JSON.stringify({
        status: "stopped",
      }),
    });

    expect(state.statusClass).toBe("tool-warning");
    expect(state.statusIconClass).toBe("codicon-warning");
  });
});
