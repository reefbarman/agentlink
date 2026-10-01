// @vitest-environment jsdom

import {
  ToolCallGroup,
  getToolGroupLabel,
  getToolGroupStatus,
  groupActivitySegments,
  segmentBlocks,
  type BlockSegment,
} from "./ToolCallGroup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
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

function skill(
  overrides: Partial<Extract<ContentBlock, { type: "skill_load" }>> = {},
): Extract<ContentBlock, { type: "skill_load" }> {
  return {
    type: "skill_load",
    id: "skill",
    skillName: "conventional-commits",
    path: "skills/conventional-commits/SKILL.md",
    content: "Use conventional commit messages.",
    inputJson: "{}",
    result: JSON.stringify({ status: "success" }),
    complete: true,
    durationMs: 3,
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

  it("merges successful skill loads with adjacent tool calls", () => {
    const first = tool("first", "read_file");
    const loaded = skill();
    const last = tool("last", "execute_command");
    expect(segmentBlocks([first, loaded, last])).toEqual([
      { kind: "tool_group", blocks: [first, loaded, last] },
    ]);
    expect(segmentBlocks([loaded])).toEqual([
      { kind: "tool_group", blocks: [loaded] },
    ]);
    expect(
      segmentBlocks([loaded], { shouldGroupToolCall: () => false }),
    ).toEqual([{ kind: "single", block: loaded, index: 0 }]);
  });

  it.each(["running", "failed", "cancelled", "rejected_by_user", "timed_out"])(
    "keeps %s skill loads visible and splits tool groups",
    (status) => {
      const first = tool("first", "read_file");
      const loaded = skill({
        complete: status !== "running",
        result: JSON.stringify({ status }),
      });
      const last = tool("last", "execute_command");
      expect(segmentBlocks([first, loaded, last])).toEqual([
        { kind: "tool_group", blocks: [first] },
        { kind: "single", block: loaded, index: 1 },
        { kind: "tool_group", blocks: [last] },
      ]);
    },
  );

  it("groups single completed successful tool calls", () => {
    const first = tool("tool-1", "read_file");
    expect(segmentBlocks([first, text()])).toEqual([
      { kind: "tool_group", blocks: [first] },
      { kind: "single", block: text(), index: 1 },
    ]);
  });

  it("can leave completed tool calls standalone while a turn is settling", () => {
    const first = tool("tool-1", "read_file");
    const second = tool("tool-2", "search_files");

    expect(
      segmentBlocks([first, second, text()], { groupCompletedTools: false }),
    ).toEqual([
      { kind: "single", block: first, index: 0 },
      { kind: "single", block: second, index: 1 },
      { kind: "single", block: text(), index: 2 },
    ]);
  });

  it("keeps warning tool calls such as non-zero exits inside the group", () => {
    const first = tool("tool-1", "read_file");
    const nonZeroExit = tool("tool-2", "execute_command", {
      result: JSON.stringify({ exit_code: 1 }),
    });
    const third = tool("tool-3", "apply_diff");

    expect(segmentBlocks([first, nonZeroExit, third])).toEqual([
      { kind: "tool_group", blocks: [first, nonZeroExit, third] },
    ]);
  });

  it("keeps rejected or timed-out tool calls standalone", () => {
    const first = tool("tool-1", "read_file");
    const rejected = tool("tool-2", "apply_diff", {
      result: JSON.stringify({ status: "rejected_by_user" }),
    });
    const timedOut = tool("tool-3", "execute_command", {
      result: JSON.stringify({ status: "timed_out", exit_code: 1 }),
    });

    expect(segmentBlocks([first, rejected, timedOut])).toEqual([
      { kind: "tool_group", blocks: [first] },
      { kind: "single", block: rejected, index: 1 },
      { kind: "single", block: timedOut, index: 2 },
    ]);
  });

  it("keeps errored tool calls standalone after a completed group", () => {
    const first = tool("tool-1", "read_file");
    const second = tool("tool-2", "search_files");
    const failed = tool("tool-3", "read_file", {
      result: JSON.stringify({ status: "error", error: "not found" }),
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

  it("groups promotion-bearing MCP tool calls with neighbouring calls", () => {
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
      { kind: "tool_group", blocks: [first, mcp, second, third] },
    ]);
  });
});

describe("groupActivitySegments", () => {
  const thinking = (id: string): ContentBlock => ({
    type: "thinking",
    id,
    text: `Reasoning ${id}`,
    complete: true,
  });
  const cycles = (count: number): ContentBlock[] =>
    Array.from({ length: count }, (_, index) => [
      thinking(`thinking-${index}`),
      tool(`tool-${index}`, "read_file"),
    ]).flat();

  it("groups three completed rows of any mix but not two", () => {
    const two = segmentBlocks(cycles(1));
    expect(groupActivitySegments(two)).toEqual(two);

    const three = segmentBlocks([...cycles(1), thinking("next")]);
    expect(groupActivitySegments(three)).toEqual([
      { kind: "activity_group", segments: three },
    ]);

    const toolsAroundThinking = segmentBlocks([
      tool("before", "read_file"),
      thinking("middle"),
      tool("after", "execute_command"),
    ]);
    expect(groupActivitySegments(toolsAroundThinking)).toEqual([
      { kind: "activity_group", segments: toolsAroundThinking },
    ]);
  });

  it("includes completed tools before and after qualifying thinking cycles", () => {
    const blocks = [
      tool("before-1", "codebase_search"),
      tool("before-2", "read_file"),
      ...cycles(3),
      tool("after", "get_context"),
    ];
    const segments = segmentBlocks(blocks);
    expect(groupActivitySegments(segments)).toEqual([
      { kind: "activity_group", segments },
    ]);
  });

  it("includes successful skill loads between thinking and tool runs", () => {
    const skill: ContentBlock = {
      type: "skill_load",
      id: "skill",
      skillName: "gram-demo-seed",
      inputJson: "{}",
      result: JSON.stringify({ status: "success" }),
      complete: true,
    };
    const blocks = [...cycles(2), skill, ...cycles(3)];
    const segments = segmentBlocks(blocks);

    expect(groupActivitySegments(segments)).toEqual([
      { kind: "activity_group", segments },
    ]);
  });

  it("keeps failed and unfinished skill loads outside Activity", () => {
    for (const skill of [
      { complete: false, result: "" },
      { complete: true, result: JSON.stringify({ status: "failed" }) },
    ]) {
      const blocks: ContentBlock[] = [
        ...cycles(3),
        { type: "skill_load", id: "skill", inputJson: "{}", ...skill },
        ...cycles(3),
      ];
      const segments = segmentBlocks(blocks);
      expect(groupActivitySegments(segments)).toEqual([
        { kind: "activity_group", segments: segments.slice(0, 6) },
        segments[6],
        { kind: "activity_group", segments: segments.slice(7) },
      ]);
    }
  });

  it("groups consecutive thinking steps without tools", () => {
    const segments = segmentBlocks([
      thinking("a"),
      thinking("b"),
      thinking("c"),
    ]);
    expect(groupActivitySegments(segments)).toEqual([
      { kind: "activity_group", segments },
    ]);
  });

  it("does not let a settling skill load turn tool groups into Activity", () => {
    const segments: BlockSegment[] = [
      { kind: "tool_group", blocks: [tool("a", "read_file")] },
      { kind: "single", block: skill(), index: 1 },
      { kind: "tool_group", blocks: [tool("b", "execute_command")] },
    ];
    expect(groupActivitySegments(segments)).toEqual(segments);
  });

  it("never wraps tool groups alone in Activity", () => {
    const segments: BlockSegment[] = ["a", "b", "c"].map((id) => ({
      kind: "tool_group",
      blocks: [tool(id, "read_file")],
    }));
    expect(groupActivitySegments(segments)).toEqual(segments);
  });

  it("groups two thinking steps with three tool groups", () => {
    const segments = segmentBlocks([
      tool("first", "execute_command"),
      ...cycles(2),
    ]);
    expect(groupActivitySegments(segments)).toEqual([
      { kind: "activity_group", segments },
    ]);
  });

  it("leaves running, failed and approval-offer groups outside the completed run", () => {
    const completed = segmentBlocks(cycles(3));
    const failed = tool("failed", "execute_command", {
      result: JSON.stringify({ status: "error", error: "timed out" }),
    });
    const promoted = tool("promoted", "mcp__write", {
      mcpApprovalPromotion: {
        serverName: "mcp",
        bareToolName: "write",
        scopes: ["session"],
      },
    });
    const running = tool("running", "execute_command", { complete: false });
    const segments = segmentBlocks([
      ...cycles(3),
      thinking("unfinished-cycle"),
      running,
      failed,
      promoted,
    ]);
    expect(groupActivitySegments(segments)).toEqual([
      {
        kind: "activity_group",
        segments: [
          ...completed,
          { kind: "single", block: thinking("unfinished-cycle"), index: 6 },
        ],
      },
      { kind: "single", block: running, index: 7 },
      { kind: "single", block: failed, index: 8 },
      { kind: "tool_group", blocks: [promoted] },
    ]);
  });

  it("leaves tool groups containing warnings outside Activity", () => {
    const nonZeroExit = tool("exit", "execute_command", {
      result: JSON.stringify({ exit_code: 1 }),
    });
    const segments = segmentBlocks([
      ...cycles(3),
      thinking("test-run"),
      nonZeroExit,
    ]);

    expect(groupActivitySegments(segments)).toEqual([
      { kind: "activity_group", segments: segments.slice(0, 7) },
      { kind: "tool_group", blocks: [nonZeroExit] },
    ]);
  });

  it("splits on text and keeps media-bearing calls visible", () => {
    const media = tool("image", "generate_image", {
      resultImages: [{ mimeType: "image/png", data: "eA==" }],
    });
    const blocks = [
      ...cycles(3),
      text("Progress update"),
      thinking("image-step"),
      media,
    ];
    const segments = segmentBlocks(blocks);
    expect(groupActivitySegments(segments)).toEqual([
      { kind: "activity_group", segments: segments.slice(0, 6) },
      ...segments.slice(6),
    ]);
  });
});

describe("getToolGroupLabel", () => {
  it("counts skill loads separately from file reads and other calls", () => {
    expect(getToolGroupLabel([tool("read", "read_file"), skill()])).toBe(
      "Explored 1 file · Loaded 1 skill",
    );
    expect(getToolGroupLabel([skill(), skill({ id: "second" })])).toBe(
      "Loaded 2 skills",
    );
  });
  it("summarizes exploration-only groups", () => {
    expect(
      getToolGroupLabel([
        tool("tool-1", "read_file"),
        tool("tool-2", "get_context"),
        tool("tool-3", "search_files"),
        tool("tool-4", "codebase_search"),
      ]),
    ).toBe("Explored 1 file, 1 search · 2 other calls");
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

  it("normalizes provider-prefixed built-in tool names", () => {
    expect(
      getToolGroupLabel([
        tool("tool-1", "functions.apply_diff"),
        tool("tool-2", "functions.execute_command"),
      ]),
    ).toBe("Edited 1 file · Ran 1 command");
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
  it("preserves skill details and order inside mixed tool groups", () => {
    const { container } = render(
      <ToolCallGroup
        blocks={[
          tool("read", "read_file"),
          skill(),
          tool("run", "execute_command"),
        ]}
      />,
    );
    const group = screen.getByRole("button", {
      name: /tools explored 1 file · ran 1 command · loaded 1 skill/i,
    });
    expect(screen.queryByRole("button", { name: /load_skill/i })).toBeNull();
    expect(
      container.querySelector(".tool-group-header .tool-call-duration")
        ?.textContent,
    ).toBe("23ms");
    fireEvent.click(group);
    expect(
      Array.from(
        container.querySelectorAll(".tool-group-children .tool-call-name"),
        (node) => node.textContent,
      ),
    ).toEqual(["read_file", "load_skill", "execute_command"]);
    fireEvent.click(screen.getByRole("button", { name: /load_skill/i }));
    expect(
      screen.getByText("skills/conventional-commits/SKILL.md"),
    ).toBeTruthy();
    expect(screen.getByText("Use conventional commit messages.")).toBeTruthy();
  });
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

  it("names non-zero exits in the collapsed badge", () => {
    render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "read_file"),
          tool("tool-2", "execute_command", {
            result: JSON.stringify({ exit_code: 1 }),
          }),
          tool("tool-3", "execute_command", {
            result: JSON.stringify({ exit_code: 2 }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("2 non-zero exits")).toBeTruthy();
  });

  it.each([
    ["tool-warning", { exit_code: 1 }],
    ["tool-error", { status: "error", error: "failed" }],
  ])(
    "scopes %s styling to the group header and affected calls",
    (statusClass, result) => {
      const { container } = render(
        <ToolCallGroup
          blocks={[
            tool("edited", "apply_diff"),
            skill(),
            tool("affected", "execute_command", {
              result: JSON.stringify(result),
            }),
            tool("successful", "execute_command", {
              result: JSON.stringify({ exit_code: 0 }),
            }),
          ]}
        />,
      );

      const groupButton = screen.getByRole("button", { name: /^Tools / });
      const statusSelector = `.${statusClass} .tool-call-status-icon`;
      expect(
        groupButton
          .querySelector(".tool-call-status-icon")
          ?.matches(statusSelector),
      ).toBe(true);

      fireEvent.click(groupButton);

      const successfulIcons = container.querySelectorAll(
        ".tool-group-children .tool-success .tool-call-status-icon",
      );
      expect(successfulIcons).toHaveLength(3);
      for (const icon of successfulIcons) {
        expect(icon.matches(statusSelector)).toBe(false);
      }
      expect(container.querySelectorAll(statusSelector)).toHaveLength(2);
    },
  );

  it("falls back to a warning count when warnings are mixed", () => {
    render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "execute_command", {
            result: JSON.stringify({ exit_code: 1 }),
          }),
          tool("tool-2", "apply_diff", {
            result: JSON.stringify({ status: "partial", partial: true }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("2 warnings")).toBeTruthy();
  });

  it("marks collapsed groups containing image results with an image badge", () => {
    render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "read_file", {
            result: "[image]",
            resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
          }),
          tool("tool-2", "read_file", {
            result: "[image]",
            resultImages: [{ mimeType: "image/jpeg", data: "ZWZnaA==" }],
          }),
          tool("tool-3", "search_files"),
        ]}
      />,
    );

    const groupButton = screen.getByRole("button", {
      name: /2 image results/i,
    });
    expect(groupButton.getAttribute("aria-expanded")).toBe("false");

    const badge = groupButton.querySelector(".tool-image-badge");
    expect(badge?.getAttribute("title")).toBe(
      "2 image results — expand to view",
    );
    expect(badge?.textContent).toContain("2");
  });

  it("renders document results without leaking placeholder lines", () => {
    render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "ask_user", {
            result: '{"responses":[]}\n[document]',
            resultDocuments: [
              {
                name: "brief.pdf",
                mimeType: "application/pdf",
                data: "cGRm",
              },
            ],
          }),
          tool("tool-2", "read_file"),
        ]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /1 document attached/i }),
    );
    expect(screen.queryByText("[document]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^ask_user/ }));
    expect(screen.getByText("brief.pdf")).toBeTruthy();
    expect(screen.getByText("application/pdf")).toBeTruthy();
    expect(screen.queryByText("[document]")).toBeNull();
  });

  it("renders a lone call directly without a Tools summary", () => {
    const { container } = render(
      <ToolCallGroup blocks={[tool("tool-1", "notion__search")]} />,
    );

    expect(container.querySelector(".tool-group-block")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Tools/ })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /^notion__search/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("omits the image badge from groups without image results", () => {
    const { container } = render(
      <ToolCallGroup
        blocks={[tool("tool-1", "read_file"), tool("tool-2", "search_files")]}
      />,
    );

    expect(container.querySelector(".tool-image-badge")).toBeNull();
  });

  it("marks collapsed groups containing MCP approval offers with a badge", () => {
    const onPromote = vi.fn();
    render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "read_file"),
          tool("tool-2", "call_mcp_tool", {
            mcpApprovalPromotion: {
              serverName: "chrome-devtools",
              bareToolName: "evaluate_script",
              scopes: ["session", "project", "global"],
            },
          }),
        ]}
        onPromoteMcpToolApproval={onPromote}
      />,
    );

    const groupButton = screen.getByRole("button", {
      name: /1 always-allow offer/i,
    });
    expect(groupButton.getAttribute("aria-expanded")).toBe("false");
    const badge = groupButton.querySelector(".tool-approval-offer-badge");
    expect(badge?.textContent).toBe("always allow");

    fireEvent.click(groupButton);
    fireEvent.click(screen.getByRole("button", { name: /^call_mcp_tool/ }));
    expect(screen.getByText("Remember this approval")).toBeTruthy();
  });

  it("omits the approval offer badge when the surface cannot promote approvals", () => {
    const { container } = render(
      <ToolCallGroup
        blocks={[
          tool("tool-1", "notion__search", {
            mcpApprovalPromotion: {
              serverName: "notion",
              bareToolName: "search",
              scopes: ["session"],
            },
          }),
        ]}
      />,
    );

    expect(container.querySelector(".tool-approval-offer-badge")).toBeNull();
  });

  it("renders historical get_context calls with the generic clickable file link", () => {
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

    fireEvent.click(screen.getByRole("button", { name: /^tools/i }));

    const fileLink = container.querySelector(".tool-file-link");
    expect(fileLink?.textContent).toBe(".../components/ToolCallGroup.test.tsx");
    expect(fileLink?.getAttribute("title")).toBe(path);

    fireEvent.click(fileLink as HTMLAnchorElement);

    expect(onOpenFile).toHaveBeenCalledWith(path, undefined);
  });
});
