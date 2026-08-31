// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import { HookCard } from "./HookCard.js";

const request: ApprovalRequest = {
  kind: "hook",
  id: "hook-approval",
  command: "python3 .agentlink/hooks/check.py",
  detail: "Source: .agentlink/hooks.json\n\nDefinition hash: abc123",
  hookChoices: [
    { label: "Run Once", value: "allow-once", isPrimary: true },
    { label: "Trust Definition", value: "trust-definition" },
    { label: "Disable Hook", value: "disable", isDanger: true },
  ],
};

afterEach(cleanup);

describe("HookCard", () => {
  it("preserves run-once, trust-definition, and disable decisions", () => {
    const submit = vi.fn();
    render(
      <HookCard
        request={request}
        submit={submit}
        followUpRef={{ current: "" }}
      />,
    );

    expect(screen.getByText(request.command!)).toBeTruthy();
    expect(screen.getByText(/Definition hash: abc123/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run Once" }));
    expect(submit).toHaveBeenLastCalledWith({
      id: request.id,
      decision: "allow-once",
      followUp: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "Trust Definition" }));
    expect(submit).toHaveBeenLastCalledWith({
      id: request.id,
      decision: "trust-definition",
      followUp: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(submit).toHaveBeenLastCalledWith({
      id: request.id,
      decision: "disable",
      rejectionReason: undefined,
    });
  });
});
