// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import { WorktreeCard } from "./WorktreeCard";
import { h } from "preact";

afterEach(cleanup);

function makeRequest(prefillPrimary = false): ApprovalRequest {
  return {
    kind: "worktree",
    id: "worktree-approval",
    command: "Start worktree agent: Reliability pass",
    detail: "Destination: /workspace/reliability",
    targetPath: "/workspace/reliability",
    worktreeChoices: [
      {
        label: "Approve and autosubmit prompt",
        value: "approve-autosubmit",
        isPrimary: !prefillPrimary,
      },
      {
        label: "Approve, prefill only",
        value: "approve-prefill",
        isPrimary: prefillPrimary,
      },
      { label: "Deny", value: "deny", isDanger: true },
    ],
  };
}

describe("WorktreeCard", () => {
  it("returns the worktree autosubmit decision from its primary action", () => {
    const submit = vi.fn();
    render(
      h(WorktreeCard, {
        request: makeRequest(),
        submit,
        followUpRef: { current: "" },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Approve and autosubmit prompt" }),
    );

    expect(submit).toHaveBeenCalledWith({
      id: "worktree-approval",
      decision: "approve-autosubmit",
      followUp: undefined,
    });
  });

  it("keeps prefill available as an explicit approval action", () => {
    const submit = vi.fn();
    render(
      h(WorktreeCard, {
        request: makeRequest(),
        submit,
        followUpRef: { current: "" },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Approve, prefill only" }),
    );

    expect(submit).toHaveBeenCalledWith({
      id: "worktree-approval",
      decision: "approve-prefill",
      followUp: undefined,
    });
  });
});
