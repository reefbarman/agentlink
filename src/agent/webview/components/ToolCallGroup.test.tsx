// @vitest-environment jsdom

import {
  ToolCallGroup,
  getToolGroupLabel,
  getToolGroupStatus,
  segmentBlocks,
} from "./ToolCallGroup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ContentBlock } from "../types";
import type { ToolCallData } from "./ToolCallBlock";

afterEach(() => {
  cleanup();
});

function tool(
  id: string,
  name: string,
  overrides: Partial<ToolCallData> = {},
): ToolCallData {
  return {
    type: "tool_call",
    id,
    name,
    inputJson: "{}",
    result: JSON.stringify({ ok: true }),
    complete: true,
    durationMs: 10,
    ...overrides,
  };
}

function text(value = "Done"): ContentBlock {
  return { type: "text", text: value };
}

describe("segmentBlocks", () => {
  it("groups consecutive completed tool calls when there are at least two", () => {
    const first = tool("tool-1", "read_file");
    const second = tool("tool-2", "search_files");
    const segments = segmentBlocks([first, second, text()]);

    expect(segments).toEqual([
      { kind: "tool_group", blocks: [first, second] },
      { kind: "single", block: text(), index: 2 },
    ]);
  });

  it("groups single completed successful tool calls", () => {
    const first = tool("tool-1", "read_file");
    expect(segmentBlocks([first, text()])).toEqual([
      { kind: "tool_group", blocks: [first] },
      { kind: "single", block: text(), index: 1 },
    ]);
  });

  it("keeps failed completed tool calls standalone after a completed group", () => {
    const first = tool("tool-1", "read_file");
    const second = tool("tool-2", "search_files");
    const failed = tool("tool-3", "execute_command", {
      result: JSON.stringify({ exit_code: 1 }),
    });

    expect(segmentBlocks([first, second, failed])).toEqual([
      { kind: "tool_group", blocks: [first, second] },
      { kind: "single", block: failed, index: 2 },
    ]);
  });

  it("keeps an incomplete running tool standalone after a completed group", () => {
    const first = tool("tool-1", "read_file");
    const second = tool("tool-2", "search_files");
    const running = tool("tool-3", "execute_command", { complete: false });

    expect(segmentBlocks([first, second, running])).toEqual([
      { kind: "tool_group", blocks: [first, second] },
      { kind: "single", block: running, index: 2 },
    ]);
  });

  it("breaks groups on non-tool blocks", () => {
    const first = tool("tool-1", "read_file");
    const second = tool("tool-2", "search_files");
    const third = tool("tool-3", "list_files");
    const fourth = tool("tool-4", "get_symbols");
    const middle = text("between");

    expect(segmentBlocks([first, second, middle, third, fourth])).toEqual([
      { kind: "tool_group", blocks: [first, second] },
      { kind: "single", block: middle, index: 2 },
      { kind: "tool_group", blocks: [third, fourth] },
    ]);
  });

  it("keeps promotion-bearing MCP tool calls out of groups", () => {
    const first = tool("tool-1", "read_file");
    const mcp = tool("tool-2", "notion__search", {
      mcpApprovalPromotion: {
        serverName: "notion",
        bareToolName: "search",
        scopes: ["session", "project", "global"],
      },
    });
    const second = tool("tool-3", "search_files");
    const third = tool("tool-4", "list_files");

    expect(segmentBlocks([first, mcp, second, third])).toEqual([
      { kind: "tool_group", blocks: [first] },
      { kind: "single", block: mcp, index: 1 },
      { kind: "tool_group", blocks: [second, third] },
    ]);
  });
});

describe("getToolGroupLabel", () => {
  it("summarizes exploration-only groups", () => {
    expect(
      getToolGroupLabel([
        tool("tool-1", "read_file"),
        tool("tool-2", "get_context"),
        tool("tool-3", "search_files"),
        tool("tool-4", "codebase_search"),
      ]),
    ).toBe("Explored 2 files, 2 searches");
  });

  it("summarizes mixed exploration and command groups", () => {
    expect(
      getToolGroupLabel([
        tool("tool-1", "search_files"),
        tool("tool-2", "list_files"),
        tool("tool-3", "execute_command"),
      ]),
    ).toBe("Explored 1 search, 1 list · Ran 1 command");
  });

  it("summarizes pure action groups", () => {
    expect(
      getToolGroupLabel([
        tool("tool-1", "write_file"),
        tool("tool-2", "apply_diff"),
        tool("tool-3", "get_terminal_output"),
      ]),
    ).toBe("Edited 2 files · Ran 1 command");
  });

  it("treats namespaced MCP-style names as other calls", () => {
    expect(
      getToolGroupLabel([
        tool("tool-1", "agentlink__read_file"),
        tool("tool-2", "notion__search"),
      ]),
    ).toBe("2 other calls");
  });
});

describe("getToolGroupStatus", () => {
  it("uses error as the worst status", () => {
    const status = getToolGroupStatus([
      tool("tool-1", "execute_command", {
        result: JSON.stringify({ exit_code: 1 }),
      }),
      tool("tool-2", "write_file", {
        result: JSON.stringify({ status: "error", error: "nope" }),
      }),
    ]);

    expect(status.statusClass).toBe("tool-error");
    expect(status.errorCount).toBe(1);
    expect(status.warningCount).toBe(1);
  });
});

describe("ToolCallGroup", () => {
  it("collapses completed tool calls behind an expandable summary", () => {
    render(
      <ToolCallGroup
        blocks={[tool("tool-1", "read_file"), tool("tool-2", "search_files")]}
      />,
    );

    const groupButton = screen.getByRole("button", {
      name: /tools explored 1 file, 1 search/i,
    });
    expect(groupButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /read_file/i })).toBeNull();

    fireEvent.click(groupButton);

    expect(groupButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /read_file/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /search_files/i })).toBeTruthy();
  });

  it("surfaces warning and failure counts on collapsed groups", () => {
    render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "execute_command", {
            result: JSON.stringify({ exit_code: 1 }),
          }),
          tool("tool-2", "apply_diff", {
            result: JSON.stringify({ status: "error", error: "failed" }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 failed")).toBeTruthy();
  });

  it("renders get_context summaries with the same clickable file link as read_file", () => {
    const onOpenFile = vi.fn();
    const path = "src/agent/webview/components/ToolCallGroup.test.tsx";
    const { container } = render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "get_context", {
            inputJson: JSON.stringify({ path }),
          }),
          tool("tool-2", "search_files", {
            inputJson: JSON.stringify({ regex: "get_context" }),
          }),
        ]}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /tools explored 1 file, 1 search/i }),
    );

    const fileLink = container.querySelector(".tool-file-link");
    expect(fileLink?.textContent).toBe(".../components/ToolCallGroup.test.tsx");
    expect(fileLink?.getAttribute("title")).toBe(path);

    fireEvent.click(fileLink as HTMLAnchorElement);

    expect(onOpenFile).toHaveBeenCalledWith(path, undefined);
  });
});
