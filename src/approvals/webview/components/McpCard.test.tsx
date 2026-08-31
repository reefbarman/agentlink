// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import { McpCard } from "./McpCard";
import { h } from "preact";

afterEach(() => {
  cleanup();
});

const request: ApprovalRequest = {
  kind: "mcp",
  id: "mcp-approval",
  command: 'Allow MCP tool "list_issues" from "linear"?',
  mcpServerName: "linear",
  mcpToolName: "list_issues",
  mcpDetail: JSON.stringify({ team: "ENG" }, null, 2),
  mcpChoices: [
    { label: "Allow once", value: "allow-once", isPrimary: true },
    { label: "Always allow tool (session)", value: "always-tool-session" },
    { label: "Always allow linear (session)", value: "always-server-session" },
    { label: "Always allow tool (project)", value: "always-tool-project" },
    { label: "Always allow linear (project)", value: "always-server-project" },
    { label: "Deny", value: "deny", isDanger: true },
  ],
};

describe("McpCard", () => {
  it("uses the standard one-time approval layout by default", () => {
    render(
      h(McpCard, {
        request,
        submit: vi.fn(),
        followUpRef: { current: "" },
      }),
    );

    expect(screen.getByText("linear / list_issues")).toBeTruthy();
    // The detail is rendered as syntax-highlighted JSON, so match on the
    // containing block's text content rather than a single text node.
    const detail = document.querySelector(".approval-detail-text");
    expect(detail?.textContent).toContain('"team": "ENG"');
    expect(detail?.querySelector(".json-key")?.textContent).toBe('"team"');
    expect(screen.getByRole("button", { name: "Allow Once" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    ).toBeTruthy();
  });

  it("saves a whole-MCP session rule through the standard rules editor", () => {
    const submit = vi.fn();
    render(
      h(McpCard, {
        request,
        submit,
        followUpRef: { current: "" },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Whole MCP" }));
    fireEvent.click(screen.getByRole("button", { name: "Session" }));

    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save Rule & Allow" }));

    expect(submit).toHaveBeenCalledWith({
      id: "mcp-approval",
      decision: "always-server-session",
      followUp: undefined,
    });
  });

  it("renders agent-tool copy without MCP rules for ACP-origin requests", () => {
    render(
      h(McpCard, {
        request: {
          kind: "mcp",
          id: "acp-approval",
          command: "Fetch release notes",
          toolOrigin: "acp",
          mcpServerName: "Claude Code",
          mcpToolName: "Fetch release notes",
          mcpDetail: JSON.stringify({ toolKind: "fetch" }, null, 2),
          mcpChoices: [
            { label: "Allow once", value: "allow", isPrimary: true },
            { label: "Reject", value: "reject", isDanger: true },
          ],
        },
        submit: vi.fn(),
        followUpRef: { current: "" },
      }),
    );

    expect(screen.getByText("External Agent Tool")).toBeTruthy();
    expect(screen.getByText("Claude Code / Fetch release notes")).toBeTruthy();
    expect(screen.queryByText(/MCP Tool/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Auto Approval Rules/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Allow Once" })).toBeTruthy();
  });
});
