// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
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
  it("describes a host sandbox that only writes in one folder", () => {
    const { container } = renderCard({
      kind: "command",
      id: "ask-agent-command-1",
      command: "npm test",
      cwd: "/work/app",
      commandSandbox: { writableRoot: "/work/app", network: "none" },
    });

    expect(screen.getByText("Sandboxed command")).toBeTruthy();
    expect(
      screen.getByText("Writes only in this folder · no network"),
    ).toBeTruthy();
    expect(screen.getByText(/can only write inside \/work\/app/)).toBeTruthy();
    expect(screen.getByText(/It has no network access\./)).toBeTruthy();
    expect(
      container.querySelector(".command-context-summary > .codicon-shield"),
    ).toBeTruthy();
  });

  it("says a background command keeps running and for how long", () => {
    renderCard({
      kind: "command",
      id: "ask-agent-command-bg",
      command: "npm run dev",
      cwd: "/work/app",
      commandSandbox: {
        writableRoot: "/work/app",
        network: "loopback",
        background: true,
        timeoutMs: 3_600_000,
      },
    });

    expect(
      screen.getByText("Background · Writes only in this folder · no internet"),
    ).toBeTruthy();
    expect(screen.getByText("Keeps running in the background")).toBeTruthy();
    expect(screen.getByText(/its 1 hour time limit/)).toBeTruthy();
  });

  it("says a loopback host sandbox can still reach local services", () => {
    renderCard({
      kind: "command",
      id: "ask-agent-command-2",
      command: "npm test",
      cwd: "/work/app",
      commandSandbox: { writableRoot: "/work/app", network: "loopback" },
    });

    expect(
      screen.getByText("Writes only in this folder · no internet"),
    ).toBeTruthy();
    expect(
      screen.getByText(/can connect to services running on this computer/),
    ).toBeTruthy();
  });

  it("says each internet destination asks when the command has the network", () => {
    renderCard({
      kind: "command",
      id: "ask-agent-command-3",
      command: "npm install",
      cwd: "/work/app",
      commandSandbox: {
        writableRoot: "/work/app",
        network: "approved-destinations",
      },
    });

    expect(
      screen.getByText(
        "Writes only in this folder · internet asks per destination",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Each new internet destination it connects to waits/),
    ).toBeTruthy();
  });

  it("presents an unsandboxed host command as full access approved on this computer", () => {
    renderCard({
      kind: "command",
      id: "ask-agent-command-4",
      command: "security find-generic-password",
      cwd: "/work/app",
      reason: "needs the keychain",
      commandSandbox: {
        writableRoot: "/work/app",
        network: "full",
        unsandboxed: true,
      },
    });

    expect(screen.getByText("Full terminal access")).toBeTruthy();
    expect(screen.getByText("One run · normal user permissions")).toBeTruthy();
    expect(screen.queryByText("Sandboxed command")).toBeNull();
    expect(
      screen.getByText("Approve on the computer running AgentLink"),
    ).toBeTruthy();
    expect(
      screen.getByText(/From another device you can only reject it/),
    ).toBeTruthy();
  });

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

  it("offers to resume automatic review only when it is paused", () => {
    const paused = request("sandbox");
    paused.humanOnlyReason =
      "Automatic command review stopped after repeated denials in this turn. Your direct approval is required.";
    paused.automaticReviewPaused = true;
    const { container, submit } = renderCard(paused);

    const handoff = container.querySelector<HTMLDetailsElement>(
      "details.command-handoff-context",
    );
    expect(handoff?.open).toBe(true);
    fireEvent.click(screen.getByText("Resume automatic review"));
    expect(submit).toHaveBeenCalledWith({
      id: paused.id,
      decision: "resume-review",
      followUp: undefined,
    });

    cleanup();
    const notPaused = request("sandbox");
    notPaused.humanOnlyReason = paused.humanOnlyReason;
    renderCard(notPaused);
    expect(screen.queryByText("Resume automatic review")).toBeNull();
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

  it("shows first-attempt evidence and immutable command text for a native recovery", () => {
    const approval = request("native", "native-escalation");
    approval.subCommands = [{ command: "npm test" }];
    approval.recoveryAttempt = {
      denialOperation: "ipc-connect",
      denialReason: "Sandbox denied host IPC",
      firstAttemptRoute: "sandbox",
      commandSent: true,
      processLaunched: true,
      mayHaveSideEffects: true,
    };
    renderCard(approval);

    expect(
      screen.getByText("Second execution after sandbox denial"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The sandbox already launched this command. A second run may repeat side effects.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run Again" })).toBeTruthy();
    expect(
      screen.getByText(/The sandbox already launched this command/),
    ).toBeTruthy();
    expect(screen.getByText(/may have side effects true/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Auto Approval Rules/ }),
    ).toBeNull();
    expect(
      document.querySelector<HTMLTextAreaElement>(".terminal-input"),
    ).toHaveProperty("readOnly", true);
  });

  it("labels pre-launch recovery as a first native run without saved rules", () => {
    const approval = request("native", "native-escalation");
    approval.recoveryAttempt = {
      denialOperation: "sandbox-runtime",
      denialReason: "Sandbox runtime unavailable",
      firstAttemptRoute: "sandbox",
      commandSent: false,
      processLaunched: false,
      mayHaveSideEffects: false,
    };
    renderCard(approval);

    expect(
      screen.getByText("Sandbox could not start the command"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The command has not run yet. Approving will run it once with your normal user permissions.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run in native terminal" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Auto Approval Rules/ }),
    ).toBeNull();
    expect(screen.queryByText("Save Rules & Run")).toBeNull();
    expect(
      document.querySelector<HTMLTextAreaElement>(".terminal-input"),
    ).toHaveProperty("readOnly", true);
  });

  it("defaults fresh rule suggestions to allow without marking them modified", () => {
    const approval = request("sandbox");
    approval.subCommands = [{ command: "npm test" }];
    renderCard(approval);

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    expect(screen.queryByText("Save Rules & Run")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" }).classList).toContain(
      "active",
    );
    fireEvent.click(screen.getByRole("button", { name: "Session" }));
    expect(screen.getByText(/without another approval card/)).toBeTruthy();
  });

  it("warns when a selected allow prefix is broad", () => {
    const approval = request("sandbox");
    approval.subCommands = [{ command: "git status" }];
    const { container } = renderCard(approval);

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Session" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    fireEvent.input(
      container.querySelector<HTMLInputElement>(".rule-pattern-input")!,
      { target: { value: "git" } },
    );

    expect(screen.getByText(/Broad prefix/)).toBeTruthy();
    expect(screen.getByText(/trust the entire command family/)).toBeTruthy();
  });

  it("labels regex allow rules consistently", () => {
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
    expect(screen.getByRole("button", { name: "Allow" }).classList).toContain(
      "active",
    );
    expect(screen.getByText(/without another approval card/)).toBeTruthy();
    expect(
      screen.getByText(/route, capabilities, environment values/),
    ).toBeTruthy();
  });

  it("upgrades a legacy rule to allow when editing another field", () => {
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
    expect(screen.getByRole("button", { name: "Allow" }).classList).toContain(
      "active",
    );
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
            decision: "allow",
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

  it("presents combined listener and mediated-network sandbox access", () => {
    const approval = request("sandbox");
    approval.security = {
      ...approval.security!,
      sandbox: {
        attestationId: "attestation-partial",
        attestationVersion: "sandbox-behavior-v1",
        policyVersion: "policy-v1",
        profileId: "workspace-write",
        backend: "seatbelt",
        architecture: "arm64",
        capabilities: {
          backend: "seatbelt",
          processTree: true,
          filesystemRead: "host-visible",
          filesystemWrite: "strict",
          network: "partial",
          privateHome: false,
          privateTmp: false,
          hostIpcBlocked: false,
          resourceLimits: "partial",
          warnings: [],
        },
      },
    };
    renderCard(approval);

    expect(
      screen.getByText("Workspace access · mediated network"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Runs with workspace access, protected metadata, private HOME and temporary files. Public connections pause for exact destination approval; private and local destinations remain blocked.",
      ),
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
