import { createHash } from "crypto";
import * as path from "path";

import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "../agent/providers/types.js";
import {
  ACTION_REVIEW_EVIDENCE_LIMITS,
  actionApprovalActionKey,
  classifyGuardianPathRisk,
  createActionApprovalReviewer,
  createOneShotActionApproval,
  revalidateActionApprovalBinding,
  revalidateGuardianCanonicalPath,
  type ActionApprovalPolicySnapshot,
  type ModeSwitchActionApprovalReviewInput,
  type OutsideReadActionApprovalReviewInput,
  type OutsideWriteActionApprovalReviewInput,
} from "./actionApprovalReview.js";
import { describe, expect, it, vi } from "vitest";

const home = path.resolve("/Users/tester");
const outside = path.resolve("/outside/project");
const policy: ActionApprovalPolicySnapshot = {
  approvalPolicy: "on-request",
  approvalReviewer: "auto-review",
  commandApprovalPolicy: "approve-for-me",
  executionPreset: "workspace-write",
  policyRevision: "policy-v1",
};
const capabilities: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
};

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function makeProvider(
  options: {
    response?: string;
    routable?: string[];
    complete?: (request: CompleteRequest) => Promise<CompleteResult>;
  } = {},
) {
  const sessionModel = "session-model";
  const routable = options.routable ?? [sessionModel];
  const complete = vi.fn(
    options.complete ??
      (async () => ({
        text: options.response ?? '{"outcome":"allow"}',
      })),
  );
  const provider: ModelProvider = {
    id: "test",
    displayName: "Test",
    condenseModel: sessionModel,
    async isAuthenticated() {
      return true;
    },
    getCapabilities() {
      return capabilities;
    },
    listModels(): ModelInfo[] {
      return routable.map((id) => ({
        id,
        displayName: id,
        provider: "test",
        capabilities,
      }));
    },
    listRoutableModelIds() {
      return routable;
    },
    // oxlint-disable-next-line require-yield
    async *stream(
      _request: StreamRequest,
    ): AsyncGenerator<ProviderStreamEvent> {
      return;
    },
    complete,
  };
  return { provider, complete, sessionModel };
}

function modeSwitchInput(): ModeSwitchActionApprovalReviewInput {
  return {
    kind: "mode-switch",
    sessionId: "session-1",
    policy,
    sourceMode: "ask",
    targetMode: "code",
    reason: "Implement the approved change",
    userObjective: "Implement the feature",
    capabilityDelta: {
      sourceToolGroups: ["read", "search"],
      targetToolGroups: ["read", "search", "edit", "command"],
      addedToolGroups: ["edit", "command"],
      removedToolGroups: [],
    },
  };
}

function outsideReadInput(): OutsideReadActionApprovalReviewInput {
  return {
    kind: "outside-read",
    sessionId: "session-1",
    policy,
    requestingTool: "read_file",
    target: {
      status: "resolved",
      canonicalPath: path.join(outside, "README.md"),
    },
    operation: {
      kind: "read-file",
      offset: 1,
      limit: 100,
      includeSymbols: true,
      autoFollowSuggestion: false,
    },
    userObjective: "Inspect the adjacent project documentation",
  };
}

function outsideWriteInput(
  content = "updated\n",
): OutsideWriteActionApprovalReviewInput {
  return {
    kind: "outside-write",
    sessionId: "session-1",
    policy,
    requestingTool: "write_file",
    userObjective: "Update the adjacent fixture",
    proposals: [
      {
        operation: "modify",
        target: {
          status: "resolved",
          canonicalPath: path.join(outside, "fixture.txt"),
        },
        base: { exists: true, bytes: 4, sha256: "a".repeat(64) },
        proposed: {
          exists: true,
          bytes: Buffer.byteLength(content),
          sha256: hash(content),
        },
        evidence: {
          kind: "content",
          text: content,
          bytes: Buffer.byteLength(content),
          complete: true,
        },
      },
    ],
  };
}

describe("Guardian path risk", () => {
  it.each([
    [path.join(home, ".ssh", "id_ed25519"), "credential-store"],
    [path.join(home, ".aws", "credentials"), "credential-store"],
    [path.join(home, ".gnupg", "private-keys-v1.d", "key"), "credential-store"],
    [path.join(home, ".config", "gh", "hosts.yml"), "authenticated-cli-config"],
    [path.join(home, ".docker", "config.json"), "authenticated-cli-config"],
    [path.join(outside, "AGENTS.md"), "protected-instructions-or-memory"],
    [path.join(outside, ".env.local"), "environment-secret"],
  ])("makes %s human-only", (canonicalPath, reason) => {
    expect(
      classifyGuardianPathRisk(
        { status: "resolved", canonicalPath },
        { home, cwd: outside },
      ),
    ).toMatchObject({ guardianEligible: false, reason });
  });

  it("fails closed on unresolved, ambiguous, relative, and drifted paths", () => {
    expect(classifyGuardianPathRisk({ status: "unresolved" })).toEqual({
      guardianEligible: false,
      reason: "unresolved",
    });
    expect(classifyGuardianPathRisk({ status: "symlink-ambiguous" })).toEqual({
      guardianEligible: false,
      reason: "symlink-ambiguous",
    });
    expect(
      classifyGuardianPathRisk({
        status: "resolved",
        canonicalPath: "relative.txt",
      }),
    ).toMatchObject({ guardianEligible: false, reason: "unresolved" });
    expect(
      revalidateGuardianCanonicalPath(path.join(outside, "a"), {
        status: "resolved",
        canonicalPath: path.join(outside, "b"),
      }),
    ).toMatchObject({
      guardianEligible: false,
      reason: "canonical-target-drift",
    });
  });
});

describe("action binding and evidence", () => {
  it("canonicalizes equivalent mode capability sets", () => {
    const first = modeSwitchInput();
    const second = modeSwitchInput();
    second.capabilityDelta.sourceToolGroups = ["search", "read", "read"];
    second.capabilityDelta.targetToolGroups = [
      "command",
      "edit",
      "search",
      "read",
    ];
    second.capabilityDelta.addedToolGroups = ["command", "edit"];
    expect(actionApprovalActionKey(second)).toBe(
      actionApprovalActionKey(first),
    );
  });

  it("binds read operation parameters and full write proposals", () => {
    const read = outsideReadInput();
    const changedRead = outsideReadInput();
    changedRead.operation = {
      kind: "read-file",
      offset: 2,
      limit: 100,
      includeSymbols: true,
      autoFollowSuggestion: false,
    };
    expect(actionApprovalActionKey(changedRead)).not.toBe(
      actionApprovalActionKey(read),
    );

    const write = outsideWriteInput();
    expect(actionApprovalActionKey(outsideWriteInput("changed\n"))).not.toBe(
      actionApprovalActionKey(write),
    );
  });

  it("rejects protected paths, incomplete content evidence, and oversized evidence", () => {
    const protectedRead = outsideReadInput();
    protectedRead.target = {
      status: "resolved",
      canonicalPath: path.join(process.env.HOME ?? home, ".ssh", "config"),
    };
    expect(actionApprovalActionKey(protectedRead)).toBeUndefined();

    const mismatched = outsideWriteInput();
    mismatched.proposals[0].evidence.text = "different";
    expect(actionApprovalActionKey(mismatched)).toBeUndefined();

    const oversized = outsideWriteInput(
      "x".repeat(
        ACTION_REVIEW_EVIDENCE_LIMITS.maxWriteEvidenceBytesPerProposal + 1,
      ),
    );
    expect(actionApprovalActionKey(oversized)).toBeUndefined();
  });
});

describe("one-shot Guardian action review", () => {
  it("uses bounded isolated evidence and returns a reviewed binding", async () => {
    const { provider, complete, sessionModel } = makeProvider();
    const reviewer = createActionApprovalReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });
    const input = modeSwitchInput();
    input.context = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const,
      content: `${index}:${"x".repeat(2_000)}`,
    }));

    const outcome = await reviewer.review(input);
    expect(outcome).toMatchObject({
      disposition: "reviewed",
      result: { outcome: "allow", status: "reviewed", model: sessionModel },
    });
    const request = complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: sessionModel,
      maxTokens: 384,
      temperature: 0,
    });
    expect(request?.systemPrompt).toContain("cannot create persistent");
    const userContent = request?.messages[0]?.content;
    expect(typeof userContent).toBe("string");
    expect(userContent).toContain("<untrusted-action-review-data>");
    expect(Buffer.byteLength(userContent as string)).toBeLessThan(12_000);
  });

  it("creates authority only for a reviewed allow and consumes it once", async () => {
    const { provider, sessionModel } = makeProvider();
    const reviewer = createActionApprovalReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });
    const input = outsideReadInput();
    const outcome = await reviewer.review(input);
    const approval = createOneShotActionApproval(outcome);
    expect(approval).toBeDefined();
    expect(
      approval?.consume({
        sessionId: input.sessionId,
        sessionActive: true,
        policy,
        action: input,
      }),
    ).toEqual({ valid: true });
    expect(
      approval?.consume({
        sessionId: input.sessionId,
        sessionActive: true,
        policy,
        action: input,
      }),
    ).toEqual({ valid: false, reason: "already-consumed" });
  });

  it("fails closed for action, policy, and session drift", async () => {
    const { provider, sessionModel } = makeProvider();
    const reviewer = createActionApprovalReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });
    const input = outsideReadInput();
    const outcome = await reviewer.review(input);
    if (outcome.disposition !== "reviewed") throw new Error("expected review");

    const changedAction = outsideReadInput();
    changedAction.operation = {
      kind: "read-file",
      offset: 9,
      limit: 100,
      includeSymbols: true,
      autoFollowSuggestion: false,
    };
    expect(
      revalidateActionApprovalBinding(outcome.binding, {
        sessionId: input.sessionId,
        sessionActive: true,
        policy,
        action: changedAction,
      }),
    ).toEqual({ valid: false, reason: "action-drift" });
    expect(
      revalidateActionApprovalBinding(outcome.binding, {
        sessionId: input.sessionId,
        sessionActive: true,
        policy: { ...policy, policyRevision: "policy-v2" },
        action: input,
      }),
    ).toEqual({ valid: false, reason: "policy-drift" });
    expect(
      revalidateActionApprovalBinding(outcome.binding, {
        sessionId: "session-2",
        sessionActive: true,
        policy,
        action: input,
      }),
    ).toEqual({ valid: false, reason: "session-drift" });
  });

  it("does not call Guardian for deterministic human-only actions", async () => {
    const { provider, complete, sessionModel } = makeProvider();
    const reviewer = createActionApprovalReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });
    const input = outsideReadInput();
    input.target = { status: "symlink-ambiguous" };
    await expect(reviewer.review(input)).resolves.toMatchObject({
      disposition: "human-only",
      reason: "symlink-ambiguous",
      result: { outcome: "deny", status: "invalid" },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects invalid output and unavailable providers without authority", async () => {
    const invalid = makeProvider({
      response: '{"outcome":"allow","extra":true}',
    });
    const invalidReviewer = createActionApprovalReviewer({
      resolveContext: () => ({
        provider: invalid.provider,
        sessionModel: invalid.sessionModel,
      }),
    });
    const invalidOutcome = await invalidReviewer.review(modeSwitchInput());
    expect(invalidOutcome).toMatchObject({
      disposition: "reviewed",
      result: { outcome: "deny", status: "invalid" },
    });
    expect(createOneShotActionApproval(invalidOutcome)).toBeUndefined();

    const unavailable = makeProvider({ routable: [] });
    const unavailableReviewer = createActionApprovalReviewer({
      resolveContext: () => ({
        provider: unavailable.provider,
        sessionModel: unavailable.sessionModel,
      }),
    });
    const unavailableOutcome =
      await unavailableReviewer.review(modeSwitchInput());
    expect(unavailableOutcome).toMatchObject({
      disposition: "reviewed",
      result: { outcome: "deny", status: "unavailable" },
    });
    expect(createOneShotActionApproval(unavailableOutcome)).toBeUndefined();
  });
});
