// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ApprovalRequest } from "../types";
import { CommandCard } from "./CommandCard";
import { h } from "preact";

function request(
  route: "native" | "sandbox",
  permissionIntent: "default" | "native-escalation" = "default",
): ApprovalRequest {
  return {
    kind: "command",
    id: `command-${route}`,
    command: "npm test",
    cwd: "/workspace/project",
    security: {
      auditId: `audit-${route}`,
      route,
      executionSurface:
        route === "sandbox" ? "verified-sandbox" : "agentlink-native",
      confinement:
        route === "sandbox" ? "verified-baseline" : "native-unsandboxed",
      routeReason: "verified-local-macos",
      requiredAuthority: route === "sandbox" ? "sandbox" : "native-agent",
      permissionIntent,
      approvalRequirement:
        permissionIntent === "native-escalation"
          ? "explicit-escalation"
          : "policy",
      authorityReason:
        permissionIntent === "native-escalation"
          ? "explicit-escalation"
          : "approval-policy",
      approvalPolicySnapshot: "on-request",
      approvalReviewerSnapshot:
        route === "sandbox" || permissionIntent === "native-escalation"
          ? "auto-review"
          : "user",
      executionPresetSnapshot:
        route === "sandbox" || permissionIntent === "native-escalation"
          ? "workspace-write"
          : "native-manual",
      commandApprovalPolicySnapshot:
        route === "sandbox" || permissionIntent === "native-escalation"
          ? "approve-for-me"
          : "manual",
      executionPolicy:
        route === "sandbox" ? "sandbox-baseline-v2" : "native-legacy-v1",
      preparedAt: 100,
    },
  };
}

function renderCard(approval: ApprovalRequest) {
  const submit = vi.fn();
  return {
    ...render(
      h(CommandCard, {
        request: approval,
        submit,
        followUpRef: { current: "" },
      }),
    ),
    submit,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommandCard terminal presentation", () => {
  it("presents normal-shell execution as the AgentLink Terminal", () => {
    const { container } = renderCard(request("native"));

    expect(screen.getByText("AgentLink Terminal")).toBeTruthy();
    expect(
      screen.getByText(
        "Runs in your normal shell environment with the same permissions as a terminal you open.",
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(".command-context-summary > .codicon-terminal"),
    ).toBeTruthy();
    expect(
      container.querySelector<HTMLDetailsElement>("details.command-context")
        ?.open,
    ).toBe(false);
    expect(screen.getByText("Normal shell permissions")).toBeTruthy();
    expect(screen.queryByText(/unsandboxed/i)).toBeNull();
  });

  it("presents native escalation with the standard card and rule controls", () => {
    const approval = request("native", "native-escalation");
    approval.subCommands = [{ command: "npm test" }];
    approval.humanOnlyReason =
      "Running outside the sandbox requires your approval unless a command approval rule already matches.";
    const { container } = renderCard(approval);

    expect(screen.getByText("Full terminal access")).toBeTruthy();
    expect(screen.getByText("Normal user permissions")).toBeTruthy();
    expect(
      screen.getByText(
        "Runs with your normal user permissions, including host files, credentials, network, and local processes.",
      ),
    ).toBeTruthy();
    const contexts = container.querySelectorAll<HTMLDetailsElement>(
      "details.command-context",
    );
    expect(contexts).toHaveLength(2);
    expect([...contexts].every((context) => !context.open)).toBe(true);
    expect(screen.getByText("Why this reached you")).toBeTruthy();
    expect(screen.getByText("Human approval required")).toBeTruthy();
    expect(screen.getByText(approval.humanOnlyReason)).toBeTruthy();
    fireEvent.click(
      screen.getByText("Full terminal access").closest("summary")!,
    );
    expect(screen.getByText("Approval mode")).toBeTruthy();
    expect(
      screen.getByText("Auto reviewer · Workspace-write preset"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    expect(screen.getByText("npm test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByText("Save Rules & Run")).toBeTruthy();
  });

  it("does not mark fresh skipped rule suggestions as modified", () => {
    const approval = request("sandbox");
    approval.subCommands = [{ command: "npm test" }];
    renderCard(approval);

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    expect(screen.queryByText("Save Rules & Run")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Approval only" }).classList,
    ).toContain("active");
    fireEvent.click(screen.getByRole("button", { name: "Session" }));
    expect(screen.queryByText(/may run matching commands outside/)).toBeNull();
  });

  it("warns when a manually selected native prefix is broad", () => {
    const approval = request("sandbox");
    approval.subCommands = [{ command: "git status" }];
    const { container } = renderCard(approval);

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Session" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow (native)" }));
    fireEvent.input(
      container.querySelector<HTMLInputElement>(".rule-pattern-input")!,
      { target: { value: "git" } },
    );

    expect(screen.getByText(/Broad native prefix/)).toBeTruthy();
    expect(screen.getByText(/trust the entire command family/)).toBeTruthy();
  });

  it("labels regex allow rules as sandboxed", () => {
    const approval = request("sandbox");
    approval.subCommands = [
      {
        command: "npm test -- --runInBand",
        existingRule: {
          pattern: "^npm test",
          mode: "regex",
          decision: "allow",
          scope: "project",
        },
      },
    ];
    renderCard(approval);

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    expect(
      screen.getByRole("button", { name: "Allow (sandboxed)" }).classList,
    ).toContain("active");
    expect(
      screen.getByText(/stays inside the Protected Terminal/),
    ).toBeTruthy();
    expect(
      screen.getByText(/do not grant native execution authority/),
    ).toBeTruthy();
  });

  it("preserves legacy approval-only authority when editing another field", () => {
    const approval = request("sandbox");
    approval.subCommands = [
      {
        command: "npm test",
        existingRule: {
          pattern: "npm test",
          mode: "exact",
          scope: "project",
        },
      },
    ];
    const { container, submit } = renderCard(approval);

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    expect(
      screen.getByRole("button", { name: "Approval only" }).classList,
    ).toContain("active");
    fireEvent.input(
      container.querySelector<HTMLInputElement>(".rule-pattern-input")!,
      { target: { value: "npm test -- --runInBand" } },
    );
    fireEvent.click(screen.getByText("Save Rules & Run"));

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "run-once",
        rules: [
          expect.objectContaining({
            pattern: "npm test -- --runInBand",
            mode: "exact",
            decision: undefined,
            scope: "project",
          }),
        ],
      }),
    );
  });

  it("presents sandboxed execution as the Protected Terminal", () => {
    const { container } = renderCard(request("sandbox"));

    expect(screen.getByText("Protected Terminal")).toBeTruthy();
    expect(
      screen.getByText(
        "Runs with workspace access, protected metadata, private HOME and temporary files, and no network access.",
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(".command-context-summary > .codicon-shield"),
    ).toBeTruthy();
    expect(
      screen.getByText("Workspace access · private HOME · no network"),
    ).toBeTruthy();
  });

  it("summarizes approval context and reveals the full evidence on demand", () => {
    const approval = request("sandbox");
    approval.reason = "Run the focused tests for the approval card changes.";
    approval.commandReview = {
      status: "reviewed",
      outcome: "deny",
      risk: "medium",
      userAuthorization: "low",
      rationale: "The command changes generated snapshots.",
      model: "review-model",
    };
    approval.humanOnlyReason = "Snapshot updates require human review.";

    const { container } = renderCard(approval);

    expect(screen.getByText(approval.reason)).toBeTruthy();
    expect(screen.getByText("medium risk")).toBeTruthy();
    const contexts = container.querySelectorAll<HTMLDetailsElement>(
      "details.command-context",
    );
    expect(contexts).toHaveLength(2);
    expect([...contexts].every((context) => !context.open)).toBe(true);

    fireEvent.click(
      screen.getByText("Why this reached you").closest("summary")!,
    );
    expect(contexts[0]?.open).toBe(false);
    expect(contexts[1]?.open).toBe(true);
    expect(screen.getByText(approval.humanOnlyReason)).toBeTruthy();
    expect(
      screen.getByText("Guardian denied · medium risk · low authorization"),
    ).toBeTruthy();
    expect(screen.getByText(approval.commandReview.rationale)).toBeTruthy();
  });
});
