// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ApprovalRequest } from "../types";
import { NetworkCard } from "./NetworkCard";
import { h } from "preact";

afterEach(cleanup);

const request: ApprovalRequest = {
  kind: "network",
  id: "network-approval",
  sourceProject: {
    projectId: "project-a",
    displayName: "Project A",
    availability: "available",
  },
  managedNetwork: {
    requestId: "network-1",
    sessionId: "session-a",
    auditId: "audit-1",
    terminalId: "sandbox-1",
    commandId: "command-1",
    generation: 1,
    command: "npm view example version",
    cwd: "/workspace",
    host: "registry.npmjs.org",
    protocol: "https",
    port: 443,
    address: "104.16.24.34",
    family: 4,
    dnsAnswers: [
      { address: "104.16.24.34", family: 4 },
      { address: "104.16.25.34", family: 4 },
    ],
    destinationClass: "public",
  },
  networkReview: {
    status: "reviewed",
    outcome: "deny",
    risk: "medium",
    userAuthorization: "unknown",
    rationale: "The destination was not clearly authorized by the user.",
    model: "guardian-model",
  },
};

describe("NetworkCard", () => {
  it("shows retained destination evidence and encrypted-content limits", () => {
    render(
      h(NetworkCard, {
        request,
        submit: vi.fn(),
        followUpRef: { current: "" },
      }),
    );

    expect(screen.getByText("https://registry.npmjs.org:443")).toBeTruthy();
    expect(screen.getByText("104.16.24.34 (IPv4)")).toBeTruthy();
    expect(screen.getByText(/104\.16\.25\.34 \(IPv4\)/)).toBeTruthy();
    expect(screen.getByText(/Redirects and later connections/)).toBeTruthy();
    expect(
      screen.getByText(/request paths, payloads, credentials/),
    ).toBeTruthy();
    expect(
      screen.getByText(/destination was not clearly authorized/),
    ).toBeTruthy();
  });

  it("submits one-shot decisions by default and exact scoped rules explicitly", () => {
    const submit = vi.fn();
    render(
      h(NetworkCard, {
        request,
        submit,
        followUpRef: { current: "" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));
    expect(submit).toHaveBeenLastCalledWith({
      id: "network-approval",
      decision: "allow-once",
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Auto Approval Rules/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save Exact Rule & Allow" }),
    );
    expect(submit).toHaveBeenLastCalledWith({
      id: "network-approval",
      decision: "allow-project",
    });
  });
});
