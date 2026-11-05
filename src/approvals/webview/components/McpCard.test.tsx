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
  const watchChoices = [
    { label: "Notify only", value: "notify" },
    { label: "Deliver automatically", value: "deliver" },
    { label: "Deliver and wake", value: "wake" },
    { label: "Deny", value: "deny", isDanger: true },
  ];

  it.each(watchChoices)(
    "submits the resource-watch choice $value without inferring a tool grant",
    (choice) => {
      const submit = vi.fn();
      const followUpRef = { current: "  Limit this to my inbox  " };
      render(
        h(McpCard, {
          request: {
            ...request,
            toolOrigin: "mcp-resource",
            command: "Watch mail://inbox/tab-1 for session tab-1",
            mcpToolName: "mail://inbox/tab-1",
            mcpDetail:
              "Notify only never reads content. Automatic delivery authorises repeated reads.",
            mcpChoices: watchChoices,
          },
          submit,
          followUpRef,
        }),
      );
      expect(screen.getByText("MCP resource watch")).toBeTruthy();
      expect(
        screen.getByText(/Future resource contents are unknown and untrusted/),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Auto Approval Rules/ }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Allow Once" })).toBeNull();
      expect(
        screen.getAllByRole("button").map((button) => button.textContent),
      ).toEqual(watchChoices.map((item) => item.label));
      expect(submit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: choice.label }));
      expect(submit).toHaveBeenCalledExactlyOnceWith({
        id: request.id,
        decision: choice.value,
        ...(choice.isDanger
          ? { rejectionReason: "Limit this to my inbox" }
          : { followUp: "Limit this to my inbox" }),
      });
      expect(followUpRef.current).toBe(
        choice.isDanger ? "" : "  Limit this to my inbox  ",
      );
    },
  );

  it("does not manufacture allow or deny actions when the host provides no watch choices", () => {
    render(
      h(McpCard, {
        request: { ...request, toolOrigin: "mcp-resource", mcpChoices: [] },
        submit: vi.fn(),
        followUpRef: { current: "" },
      }),
    );
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("names the OAuth browser action and omits unavailable approval rules", () => {
    const submit = vi.fn();
    render(
      h(McpCard, {
        request: {
          ...request,
          mcpToolName: "OAuth authorization",
          mcpDetail:
            "AgentLink will open your system browser to https://example.com",
          mcpChoices: [
            { label: "Open browser", value: "allow-once", isPrimary: true },
            { label: "Deny", value: "deny", isDanger: true },
          ],
        },
        submit,
        followUpRef: { current: "" },
      }),
    );
    expect(screen.getByText("Connect linear to AgentLink")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Auto Approval Rules/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(submit).toHaveBeenCalledWith({
      id: request.id,
      decision: "allow-once",
      followUp: undefined,
    });
  });

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

  it.each(["tool", "server"])(
    "offers a Global %s rule without project controls in projectless Desktop",
    (target) => {
      const submit = vi.fn();
      render(
        h(McpCard, {
          request: {
            ...request,
            mcpChoices: [
              ...request.mcpChoices!.filter(
                (choice) => !choice.value.endsWith("-project"),
              ),
              {
                label: "Always allow tool (global)",
                value: "always-tool-global",
              },
              {
                label: "Always allow server (global)",
                value: "always-server-global",
              },
            ],
          },
          submit,
          followUpRef: { current: "" },
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Auto Approval Rules/ }),
      );
      expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
      expect(
        screen.getByRole("group", { name: "Approval target" }),
      ).toBeTruthy();
      if (target === "server")
        fireEvent.click(screen.getByRole("button", { name: "Whole MCP" }));
      const global = screen.getByRole("button", { name: "Global" });
      expect(global.hasAttribute("disabled")).toBe(false);
      fireEvent.click(global);
      expect(global.getAttribute("aria-pressed")).toBe("true");
      expect(
        screen.getByText(/future conversations in Desktop and VS Code/),
      ).toBeTruthy();
      expect(submit).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "Save Rule & Allow" }),
      );
      expect(submit).toHaveBeenCalledWith({
        id: "mcp-approval",
        decision: `always-${target}-global`,
        followUp: undefined,
      });
    },
  );

  it("retains Project when the MCP host offers project approvals", () => {
    const submit = vi.fn();
    render(h(McpCard, { request, submit, followUpRef: { current: "" } }));
    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Rule & Allow" }));
    expect(submit).toHaveBeenCalledWith({
      id: "mcp-approval",
      decision: "always-tool-project",
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
