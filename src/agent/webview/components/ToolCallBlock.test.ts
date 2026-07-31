// @vitest-environment jsdom

import {
  ToolCallBlock,
  formatToolFileDisplayPath,
  getCommandApprovalBadge,
  getToolCallVisualState,
} from "./ToolCallBlock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { h } from "preact";

afterEach(() => {
  cleanup();
});

describe("ToolCallBlock", () => {
  it("shows known input when expanded while the tool call is running", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "running-read",
          name: "read_file",
          inputJson: JSON.stringify({ path: "src/agent/AgentEngine.ts" }),
          result: "",
          complete: false,
        },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));

    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getAllByText(/src\/agent\/AgentEngine\.ts/)).toHaveLength(2);
  });

  it("renders completed ACP-native tools with generic input and result details", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "acp-bash",
          name: "Bash",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: "102 tests passed",
          complete: true,
        },
      }),
    );

    const header = screen.getByRole("button", { name: "Bash" });
    expect(header.querySelector(".codicon-check")).toBeTruthy();
    expect(header.querySelector(".codicon-modifier-spin")).toBeNull();

    fireEvent.click(header);

    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getAllByText(/npm test/)).toHaveLength(2);
    expect(screen.getByText("102 tests passed")).toBeTruthy();
  });

  it("renders failed ACP-native tools as errors instead of running", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "acp-read",
          name: "Read",
          inputJson: JSON.stringify({ file_path: "src/index.ts" }),
          result: JSON.stringify({ status: "failed", output: "not found" }),
          complete: true,
        },
      }),
    );

    const header = screen.getByRole("button", { name: "Read" });
    expect(header.querySelector(".codicon-error")).toBeTruthy();
    expect(header.querySelector(".codicon-modifier-spin")).toBeNull();
  });

  it("opens a collapsed summary file link without toggling the tool details", () => {
    const onOpenFile = vi.fn();
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "summary-path",
          name: "read_file",
          inputJson: JSON.stringify({ path: "/tmp/tool-result.txt" }),
          result: JSON.stringify({ total_lines: 12 }),
          complete: true,
        },
        onOpenFile,
      }),
    );

    const fileLink = screen.getByRole("link", { name: "/tmp/tool-result.txt" });
    expect(fileLink.closest("button")).toBeNull();

    fireEvent.click(fileLink);

    expect(onOpenFile).toHaveBeenCalledWith("/tmp/tool-result.txt", undefined);
    expect(screen.queryByText("Input")).toBeNull();
  });

  it("linkifies file paths embedded in ACP-native summary text", () => {
    const onOpenFile = vi.fn();
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "acp-summary-path",
          name: "Read:",
          inputJson: JSON.stringify({
            description:
              "Inspect /Users/tristan/workspace/agentlink/src/agent/ChatViewProvider.ts:42",
          }),
          result: "file contents",
          complete: true,
        },
        onOpenFile,
      }),
    );

    const fileLink = screen.getByRole("link", {
      name: "/Users/tristan/workspace/agentlink/src/agent/ChatViewProvider.ts:42",
    });
    expect(fileLink.closest(".tool-call-summary")).toBeTruthy();

    fireEvent.click(fileLink);

    expect(onOpenFile).toHaveBeenCalledWith(
      "/Users/tristan/workspace/agentlink/src/agent/ChatViewProvider.ts",
      42,
    );
    expect(screen.queryByText("Input")).toBeNull();
  });

  it("leaves ACP-native summary paths as plain text without file navigation", () => {
    const path =
      "/Users/tristan/workspace/agentlink/src/agent/ChatViewProvider.ts";
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "acp-summary-without-navigation",
          name: "Read:",
          inputJson: JSON.stringify({ description: path }),
          result: "file contents",
          complete: true,
        },
      }),
    );

    expect(screen.getByText(path)).toBeTruthy();
    expect(screen.queryByRole("link", { name: path })).toBeNull();
  });

  it("keeps a summary path whole when it crosses the truncation boundary", () => {
    const onOpenFile = vi.fn();
    const path =
      "/Users/tristan/workspace/agentlink/src/agent/ChatViewProvider.ts";
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "acp-long-summary-path",
          name: "Read:",
          inputJson: JSON.stringify({
            description: `${"Inspect approval handling carefully ".repeat(2)}${path} before editing`,
          }),
          result: "file contents",
          complete: true,
        },
        onOpenFile,
      }),
    );

    fireEvent.click(screen.getByRole("link", { name: path }));

    expect(onOpenFile).toHaveBeenCalledWith(path, undefined);
  });

  it("opens file paths from expanded JSON input and results", () => {
    const onOpenFile = vi.fn();
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "json-paths",
          name: "custom_tool",
          inputJson: JSON.stringify({ path: "src/agent/AgentEngine.ts" }),
          result: JSON.stringify({
            source: "src/agent/ChatViewProvider.ts:42",
          }),
          complete: true,
        },
        onOpenFile,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /custom_tool/i }));
    fireEvent.click(screen.getByTitle("Open src/agent/AgentEngine.ts"));
    fireEvent.click(
      screen.getByRole("link", {
        name: "src/agent/ChatViewProvider.ts:42",
      }),
    );

    expect(onOpenFile).toHaveBeenNthCalledWith(
      1,
      "src/agent/AgentEngine.ts",
      undefined,
    );
    expect(onOpenFile).toHaveBeenNthCalledWith(
      2,
      "src/agent/ChatViewProvider.ts",
      42,
    );
  });

  it("opens file paths from expanded plain-text results", () => {
    const onOpenFile = vi.fn();
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "text-path",
          name: "custom_tool",
          inputJson: "{}",
          result: "Updated src/agent/webview/App.tsx:2337",
          complete: true,
        },
        onOpenFile,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /custom_tool/i }));
    const expandedResult = screen.getByText("Result").parentElement;
    const fileLink =
      expandedResult?.querySelector<HTMLAnchorElement>(".tool-file-link");
    expect(fileLink?.textContent).toBe("src/agent/webview/App.tsx:2337");

    fireEvent.click(fileLink as HTMLAnchorElement);

    expect(onOpenFile).toHaveBeenCalledWith("src/agent/webview/App.tsx", 2337);
  });

  it("shows image results as previews instead of placeholder text when expanded", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "read-image",
          name: "read_file",
          inputJson: JSON.stringify({ path: "assets/pixel.ppm" }),
          result: "[image]",
          resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
          complete: true,
        },
      }),
    );

    expect(
      screen.queryByRole("img", { name: "read_file result image 1" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));

    const preview = screen.getByRole("img", {
      name: "read_file result image 1",
    });
    expect(preview.getAttribute("src")).toBe("data:image/png;base64,YWJjZA==");
    expect(screen.queryByText("[image]")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open read_file result image 1" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "read_file result image 1",
    });
    expect(dialog.parentElement).toBe(document.body);
    expect(
      dialog.querySelector(".user-image-lightbox-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,YWJjZA==");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "read_file result image 1" }),
    ).toBeNull();
  });

  it("marks the collapsed header with an image badge when the result contains images", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "read-image",
          name: "read_file",
          inputJson: JSON.stringify({ path: "assets/pixel.ppm" }),
          result: "[image]",
          resultImages: [
            { mimeType: "image/png", data: "YWJjZA==" },
            { mimeType: "image/jpeg", data: "ZWZnaA==" },
          ],
          complete: true,
        },
      }),
    );

    const badge = screen.getByRole("img", { name: "2 image results" });
    expect(badge.getAttribute("title")).toBe(
      "2 image results — expand to view",
    );
    expect(badge.textContent).toContain("2");
  });

  it("does not show an image badge while the tool call is still running", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "read-image",
          name: "read_file",
          inputJson: JSON.stringify({ path: "assets/pixel.ppm" }),
          result: "",
          resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
          complete: false,
        },
      }),
    );

    expect(screen.queryByRole("img", { name: "1 image result" })).toBeNull();
  });

  it("does not show an image badge for text-only results", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "read-text",
          name: "read_file",
          inputJson: JSON.stringify({ path: "src/index.ts" }),
          result: JSON.stringify({ ok: true }),
          complete: true,
        },
      }),
    );

    expect(document.querySelector(".tool-image-badge")).toBeNull();
  });

  it("renders MCP approval promotion as a labeled scope group", () => {
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "mcp-search",
          name: "notion__search",
          inputJson: JSON.stringify({ query: "launch plan" }),
          result: JSON.stringify({ ok: true }),
          complete: true,
          mcpApprovalPromotion: {
            serverName: "notion",
            bareToolName: "search",
            scopes: ["session", "project", "global"],
          },
        },
        onPromoteMcpToolApproval: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /notion__search/i }));

    expect(screen.getByText("Remember this approval")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Remember MCP tool approval" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Allow for this chat session" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Allow whenever this project uses the tool",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Allow whenever any project uses the tool",
      }),
    ).toBeTruthy();
  });

  it("promotes the chosen MCP approval scope and removes that action", () => {
    const onPromoteMcpToolApproval = vi.fn();
    render(
      h(ToolCallBlock, {
        toolCall: {
          type: "tool_call",
          id: "mcp-search",
          name: "notion__search",
          inputJson: "{}",
          result: JSON.stringify({ ok: true }),
          complete: true,
          mcpApprovalPromotion: {
            serverName: "notion",
            bareToolName: "search",
            scopes: ["session", "project"],
          },
        },
        onPromoteMcpToolApproval,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /notion__search/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Allow for this chat session" }),
    );

    expect(onPromoteMcpToolApproval).toHaveBeenCalledWith({
      serverName: "notion",
      bareToolName: "search",
      scope: "session",
    });
    expect(
      screen.queryByRole("button", { name: "Allow for this chat session" }),
    ).toBeNull();
  });
});

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

describe("getCommandApprovalBadge", () => {
  it("identifies verified sandbox reviewer approvals", () => {
    expect(
      getCommandApprovalBadge({
        approval: {
          by: "model_reviewer",
          model: "review-model",
          tier: "sensitive",
          outcome: "allow",
          risk: "medium",
          user_authorization: "high",
          rationale: "Bounded workspace mutation",
        },
        security: {
          route: "sandbox",
          confinement: "verified-baseline",
          sandbox: {
            profileId: "workspace-write",
            attestationVersion: "sandbox-behavior-v2",
          },
        },
      }),
    ).toEqual({
      text: "approved · reviewer · sandbox",
      title: expect.stringContaining(
        "Verified sandbox (workspace-write) · sandbox-behavior-v2",
      ),
    });
  });

  it("identifies sandbox verification auto-approval", () => {
    expect(
      getCommandApprovalBadge({
        approval: { by: "sandbox_verification" },
        security: {
          route: "sandbox",
          confinement: "verified-baseline",
          sandbox: {
            profileId: "workspace-write",
            attestationVersion: "sandbox-behavior-v3",
          },
        },
      }),
    ).toEqual({
      text: "auto · verification · sandbox",
      title: expect.stringContaining(
        "recognized project verification command in the verified baseline sandbox",
      ),
    });
  });

  it("identifies unsandboxed native approvals and their route reason", () => {
    expect(
      getCommandApprovalBadge({
        approval: { by: "explicit_rule" },
        security: {
          route: "native",
          confinement: "native-unsandboxed",
          routeReason: "runtime-unavailable",
          approvalReviewerSnapshot: "auto-review",
          executionPresetSnapshot: "workspace-write",
        },
      }),
    ).toEqual({
      text: "approved · rule · native",
      title: expect.stringContaining(
        "Native terminal (unsandboxed) · runtime-unavailable · Auto reviewer · Workspace-write preset",
      ),
    });
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
