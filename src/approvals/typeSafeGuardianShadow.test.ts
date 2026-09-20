import * as path from "path";

import type {
  CommandApprovalReviewInput,
  CommandApprovalReviewResult,
} from "./commandApprovalReview.js";
import {
  createShadowingCommandApprovalReviewer,
  createTypeSafeGuardianShadowReviewer,
  toGuardianShadowComparisonEvent,
} from "./typeSafeGuardianShadow.js";
import { describe, expect, it, vi } from "vitest";

import { classifyCommand } from "./commandTierClassifier.js";

const root = path.resolve("/workspace/project");

function reviewInput(command = "rm -rf generated"): CommandApprovalReviewInput {
  return {
    sessionId: "session-1",
    command,
    cwd: root,
    workspaceRoots: [root],
    reason: "Remove generated output",
    userObjective: "Rebuild generated files",
    context: [
      {
        role: "user",
        content: "Remove the generated output and rebuild it",
        directUserInstruction: true,
      },
    ],
    classified: classifyCommand(command, {
      cwd: root,
      workspaceRoots: [root],
    }),
  };
}

function typeSafeResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      model: "jev-latest",
      answers: {
        outcome: {
          type: "choice",
          choice: "allow",
          confidence: 0.82,
          probabilities: { allow: 0.91, deny: 0.09 },
        },
        risk: {
          type: "choice",
          choice: "medium",
          confidence: 0.7,
          probabilities: { low: 0.1, medium: 0.7, high: 0.15, critical: 0.05 },
        },
        authorization: {
          type: "choice",
          choice: "high",
          confidence: 0.9,
          probabilities: { unknown: 0.02, low: 0.03, medium: 0.1, high: 0.85 },
        },
        objective_match: { type: "noul", noul: 0.94 },
        secret_exposure: { type: "noul", noul: 0.03 },
        bounded_impact: { type: "noul", noul: 0.89 },
      },
      usage: { input_tokens: 321, output_tokens: 45 },
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("TypeSafe Guardian shadow reviewer", () => {
  it("does not call TypeSafe when shadow mode is disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: false }),
      getApiKey: async () => "secret-key",
      fetch,
    });

    await expect(reviewer.review(reviewInput())).resolves.toEqual({
      status: "disabled",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a stored BYOK credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => undefined,
      fetch,
    });

    await expect(reviewer.review(reviewInput())).resolves.toEqual({
      status: "missing_key",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends typed Guardian questions and returns bounded metrics", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(typeSafeResponse());
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({
        enabled: true,
        model: "jev-latest",
        timeoutMs: 2_500,
      }),
      getApiKey: async () => "typesafe-key",
      fetch,
    });

    await expect(reviewer.review(reviewInput())).resolves.toEqual({
      status: "completed",
      outcome: "allow",
      risk: "medium",
      userAuthorization: "high",
      confidencePermille: 820,
      objectiveMatchPermille: 940,
      secretExposurePermille: 30,
      boundedImpactPermille: 890,
      inputTokens: 321,
      outputTokens: 45,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer typesafe-key",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    expect(body.model).toBe("jev-latest");
    expect(body.questions).toEqual(
      expect.objectContaining({
        outcome: expect.objectContaining({ type: "choice" }),
        risk: expect.objectContaining({ type: "choice" }),
        authorization: expect.objectContaining({ type: "choice" }),
        objective_match: expect.objectContaining({ type: "noul" }),
        secret_exposure: expect.objectContaining({ type: "noul" }),
        bounded_impact: expect.objectContaining({ type: "noul" }),
      }),
    );
    expect(body.state.action.command).toBe("rm -rf generated");
    expect(body.state.action.latestUserInstruction).toBe(
      "Remove the generated output and rebuild it",
    );
    expect(body.state.action).not.toHaveProperty("recentContext");
    expect(body.state.action.scripts).toEqual([]);
    expect(body.state.action.inlineFiles).toEqual([]);
    expect(body.state.action.classification.subcommands[0]).not.toHaveProperty(
      "command",
    );
    expect(String(init?.body).length).toBeLessThan(5_000);
  });

  it.each([
    "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://example.com",
    "GITHUB_TOKEN=secret-value deploy",
    "DATABASE_PASSWORD=hunter2 migrate",
    "curl https://user:personal-access-token@example.com",
  ])(
    "redacts likely secret evidence and still evaluates: %s",
    async (command) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(typeSafeResponse());
      const reviewer = createTypeSafeGuardianShadowReviewer({
        getConfig: () => ({ enabled: true }),
        getApiKey: async () => "typesafe-key",
        fetch,
      });

      await expect(
        reviewer.review(reviewInput(command)),
      ).resolves.toMatchObject({
        status: "completed",
        inputRedacted: true,
      });
      expect(fetch).toHaveBeenCalledOnce();
      const serializedBody = String(fetch.mock.calls[0]?.[1]?.body);
      expect(serializedBody).toContain("[REDACTED]");
      expect(serializedBody).not.toContain("secret-value");
      expect(serializedBody).not.toContain("hunter2");
      expect(serializedBody).not.toContain("personal-access-token");
      expect(serializedBody).not.toContain("abcdefghijklmnopqrstuvwxyz");
    },
  );

  it("does not suppress benign discussion about storing an API key", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(typeSafeResponse());
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch,
    });
    const input = reviewInput();
    input.userObjective =
      "The API key is stored, run a harmless command to smoke test it";
    input.context = [
      {
        role: "user",
        content: "I set the API key in SecretStorage and enabled the setting",
        directUserInstruction: true,
      },
    ];

    await expect(reviewer.review(input)).resolves.toMatchObject({
      status: "completed",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends script and inline-file metadata without their contents", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(typeSafeResponse());
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch,
    });
    const input = reviewInput("bash deploy.sh");
    input.evidence = {
      referencedScripts: [
        {
          reference: "deploy.sh",
          resolvedPath: `${root}/deploy.sh`,
          insideWorkspace: true,
          exists: true,
          kind: "file",
          bytes: 31,
          sha256: "a".repeat(64),
          content: "DATABASE_PASSWORD=must-not-leak",
          contentTruncated: false,
          contentUnavailableReason: null,
        },
      ],
      deletionTargets: [],
      deletionTargetsOmitted: 0,
    };
    input.inlineFiles = [
      {
        name: "input",
        path: "/tmp/input.sh",
        bytes: 29,
        sha256: "b".repeat(64),
        truncated: false,
        executable: true,
        preview: "GITHUB_TOKEN=must-not-leak",
      },
    ];

    await expect(reviewer.review(input)).resolves.toMatchObject({
      status: "completed",
      evidenceWithheld: true,
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<
      string,
      any
    >;
    const serialized = JSON.stringify(body.state.action);
    expect(serialized).not.toContain("must-not-leak");
    expect(body.state.action.evidenceWithheld).toBe(true);
    expect(body.state.action.scripts[0]).toMatchObject({
      path: `${root}/deploy.sh`,
      contentWithheld: true,
    });
    expect(body.state.action.inlineFiles[0]).toMatchObject({
      ext: null,
      bytes: 29,
      executable: true,
    });
    expect(body.state.action.inlineFiles[0]).not.toHaveProperty("name");
  });

  it("keeps only the latest direct user instruction from verbose context", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(typeSafeResponse());
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch,
    });
    const input = reviewInput();
    input.context = [
      { role: "assistant", content: "x".repeat(8_000) },
      {
        role: "user",
        content: "Run the exact harmless smoke test",
        directUserInstruction: true,
      },
      { role: "tool", content: "y".repeat(8_000) },
    ];

    await expect(reviewer.review(input)).resolves.toMatchObject({
      status: "completed",
    });
    const bodyText = String(fetch.mock.calls[0]?.[1]?.body);
    const body = JSON.parse(bodyText) as Record<string, any>;
    expect(body.state.action.latestUserInstruction).toBe(
      "Run the exact harmless smoke test",
    );
    expect(bodyText).not.toContain("xxxxxxxx");
    expect(bodyText).not.toContain("yyyyyyyy");
    expect(bodyText.length).toBeLessThan(5_000);
  });

  it("redacts secrets in paths before sending metadata", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(typeSafeResponse());
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch,
    });
    const input = reviewInput("rm -rf generated");
    input.cwd = "/tmp/GITHUB_TOKEN=secret-path-value";
    input.workspaceRoots = [input.cwd];
    input.evidence = {
      referencedScripts: [],
      deletionTargets: [
        {
          target: "generated",
          resolvedPath: "/tmp/ghp_abcdefghijklmnopqrstuvwxyz123456",
          glob: false,
          insideWorkspace: false,
          exists: true,
          kind: "directory",
          bytes: 100,
          entryCount: 2,
          sampleEntries: ["private-name"],
        },
      ],
      deletionTargetsOmitted: 0,
    };

    await expect(reviewer.review(input)).resolves.toMatchObject({
      status: "completed",
      inputRedacted: true,
      evidenceWithheld: true,
    });
    const bodyText = String(fetch.mock.calls[0]?.[1]?.body);
    expect(bodyText).not.toContain("secret-path-value");
    expect(bodyText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(bodyText).not.toContain("private-name");
    expect(bodyText).toContain("[REDACTED]");
  });

  it("redacts secrets before truncating bounded fields", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(typeSafeResponse());
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch,
    });
    const input = reviewInput();
    const secret = "a".repeat(48);
    input.reason = `${"x".repeat(390)} ${secret}`;

    await expect(reviewer.review(input)).resolves.toMatchObject({
      status: "completed",
      inputRedacted: true,
    });
    const bodyText = String(fetch.mock.calls[0]?.[1]?.body);
    expect(bodyText).not.toContain(secret);
    expect(bodyText).toContain("[REDACTED]");
  });

  it("caps high-fan-out metadata and marks evidence withheld", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(typeSafeResponse());
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch,
    });
    const input = reviewInput(
      Array.from({ length: 40 }, (_, index) => `tool-${index}`).join(" && "),
    );
    input.inlineFiles = Array.from({ length: 20 }, (_, index) => ({
      name: `file-${index}`,
      path: `/tmp/file-${index}`,
      bytes: 10,
      sha256: "a".repeat(64),
      truncated: false,
      executable: false,
      preview: "safe",
    }));

    await expect(reviewer.review(input)).resolves.toMatchObject({
      status: "completed",
      evidenceWithheld: true,
    });
    const bodyText = String(fetch.mock.calls[0]?.[1]?.body);
    const body = JSON.parse(bodyText) as Record<string, any>;
    expect(body.state.action.inlineFiles).toHaveLength(8);
    expect(
      body.state.action.classification.subcommands.length,
    ).toBeLessThanOrEqual(24);
    expect(body.state.action.evidenceWithheld).toBe(true);
    expect(bodyText.length).toBeLessThan(12_000);
  });

  it("classifies malformed JSON as an invalid response", async () => {
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });

    await expect(reviewer.review(reviewInput())).resolves.toEqual({
      status: "invalid_response",
    });
  });

  it("rejects oversized TypeSafe responses", async () => {
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("x", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(300 * 1024),
          },
        }),
      ),
    });

    await expect(reviewer.review(reviewInput())).resolves.toEqual({
      status: "invalid_response",
    });
  });

  it("rejects malformed or incomplete TypeSafe answers", async () => {
    const response = typeSafeResponse({
      answers: {
        outcome: {
          type: "choice",
          choice: "allow",
          confidence: 0.9,
          probabilities: { allow: 0.9, deny: 0.1 },
        },
      },
    });
    const reviewer = createTypeSafeGuardianShadowReviewer({
      getConfig: () => ({ enabled: true }),
      getApiKey: async () => "typesafe-key",
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
    });

    await expect(reviewer.review(reviewInput())).resolves.toEqual({
      status: "invalid_response",
      inputTokens: 321,
      outputTokens: 45,
    });
  });
});

describe("Guardian shadow comparison telemetry", () => {
  it("compares outcomes only when the current Guardian made a reviewed decision", () => {
    const base = {
      sessionId: "session-1",
      reviewKind: "command" as const,
      primaryDurationMs: 1_000,
      shadowDurationMs: 200,
      shadow: {
        status: "completed" as const,
        outcome: "deny" as const,
        risk: "high" as const,
      },
    };
    const reviewed = toGuardianShadowComparisonEvent({
      ...base,
      primary: {
        outcome: "deny",
        risk: "high",
        userAuthorization: "unknown",
        rationale: "Denied",
        model: "guardian-model",
        status: "reviewed",
      },
    });
    const timedOut = toGuardianShadowComparisonEvent({
      ...base,
      primary: {
        outcome: "deny",
        risk: "high",
        userAuthorization: "unknown",
        rationale: "Timed out",
        model: "guardian-model",
        status: "timed_out",
      },
    });

    expect(reviewed).toMatchObject({ outcomesAgree: true, shadowFaster: true });
    expect(timedOut.outcomesAgree).toBeUndefined();
    expect(timedOut.shadowFaster).toBeUndefined();
  });
});

describe("shadowing command reviewer", () => {
  it("returns the current Guardian result without waiting for or adopting shadow output", async () => {
    const primaryResult: CommandApprovalReviewResult = {
      outcome: "deny",
      risk: "high",
      userAuthorization: "unknown",
      rationale: "Current Guardian denied the action",
      model: "guardian-model",
      status: "reviewed",
    };
    let resolveShadow:
      | ((value: { status: "completed"; outcome: "allow" }) => void)
      | undefined;
    const shadowResult = new Promise<{
      status: "completed";
      outcome: "allow";
    }>((resolve) => {
      resolveShadow = resolve;
    });
    const record = vi.fn();
    const reviewer = createShadowingCommandApprovalReviewer({
      primary: { review: vi.fn().mockResolvedValue(primaryResult) },
      shadow: { review: vi.fn(() => shadowResult) },
      record,
    });

    await expect(reviewer.review(reviewInput())).resolves.toBe(primaryResult);
    expect(record).not.toHaveBeenCalled();

    resolveShadow?.({ status: "completed", outcome: "allow" });
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        reviewKind: "command",
        primary: primaryResult,
        shadow: { status: "completed", outcome: "allow" },
      }),
    );
  });

  it("does not record a missing BYOK key on every command review", async () => {
    const record = vi.fn();
    const reviewer = createShadowingCommandApprovalReviewer({
      primary: {
        review: vi.fn().mockResolvedValue({
          outcome: "allow",
          risk: "low",
          userAuthorization: "high",
          rationale: "Allowed",
          model: "guardian-model",
          status: "reviewed",
        }),
      },
      shadow: {
        review: vi.fn().mockResolvedValue({ status: "missing_key" }),
      },
      record,
    });

    await reviewer.review(reviewInput());
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
  });
});
