// @vitest-environment jsdom

import { h } from "preact";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../types";
import { McpCard } from "./McpCard";

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
  it("defaults to a one-time grant and clearly identifies the request", () => {
    render(
      h(McpCard, {
        request,
        submit: vi.fn(),
        followUpRef: { current: "" },
      }),
    );

    expect(screen.getByText("linear")).toBeTruthy();
    expect(screen.getByText("list_issues")).toBeTruthy();
    expect(screen.getByLabelText(/Run once/)).toHaveProperty("checked", true);
    expect(screen.getByText(/"team": "ENG"/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run tool once" })).toBeTruthy();
  });

  it("offers an entire-MCP session grant and submits it only after confirmation", () => {
    const submit = vi.fn();
    render(
      h(McpCard, {
        request,
        submit,
        followUpRef: { current: "" },
      }),
    );

    fireEvent.click(
      screen.getByLabelText(/Entire linear MCP for this session/),
    );

    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(
      /skips future prompts for every tool/i,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Allow MCP for session" }),
    );

    expect(submit).toHaveBeenCalledWith({
      id: "mcp-approval",
      decision: "always-server-session",
      followUp: undefined,
    });
  });
});
