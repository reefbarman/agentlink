import type {
  CompleteRequest,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "../agent/providers/types.js";
import {
  createNetworkApprovalReviewer,
  parseNetworkApprovalReviewResponse,
} from "./networkApprovalReview.js";
import { describe, expect, it, vi } from "vitest";

const capabilities: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
};

function makeProvider(response = '{"outcome":"allow"}') {
  const model = "guardian-model";
  const complete = vi.fn(async (_request: CompleteRequest) => ({
    text: response,
  }));
  const provider: ModelProvider = {
    id: "test",
    displayName: "Test",
    condenseModel: model,
    async isAuthenticated() {
      return true;
    },
    getCapabilities() {
      return capabilities;
    },
    listModels(): ModelInfo[] {
      return [
        {
          id: model,
          displayName: model,
          provider: "test",
          capabilities,
        },
      ];
    },
    listRoutableModelIds() {
      return [model];
    },
    // oxlint-disable-next-line require-yield
    async *stream(
      _request: StreamRequest,
    ): AsyncGenerator<ProviderStreamEvent> {
      return;
    },
    complete,
  };
  return { provider, model, complete };
}

function reviewInput(signal?: AbortSignal) {
  return {
    request: {
      requestId: "network-1",
      sessionId: "session-1",
      auditId: "audit-1",
      terminalId: "sandbox-1",
      commandId: "command-1",
      generation: 1,
      command: "npm view example version",
      cwd: "/workspace",
      reason: "Managed public network requested",
      host: "registry.npmjs.org",
      protocol: "https" as const,
      port: 443,
      address: "104.16.24.34",
      family: 4 as const,
      dnsAnswers: [
        { address: "104.16.24.34", family: 4 as const },
        { address: "104.16.25.34", family: 4 as const },
      ],
      destinationClass: "public" as const,
    },
    userObjective: "Check the package version",
    context: [{ role: "user" as const, content: "Check the package version" }],
    signal,
  };
}

describe("network approval response parser", () => {
  it("accepts compact allows with conservative defaults", () => {
    expect(parseNetworkApprovalReviewResponse('{"outcome":"allow"}')).toEqual({
      outcome: "allow",
      risk: "low",
      userAuthorization: "unknown",
      rationale: "Guardian allowed the destination",
      status: "reviewed",
    });
  });

  it.each([
    "not json",
    '{"outcome":"approve"}',
    '{"outcome":"allow","extra":true}',
    '{"outcome":"allow","risk_level":"severe"}',
  ])("fails closed for invalid output %s", (text) => {
    expect(parseNetworkApprovalReviewResponse(text)).toMatchObject({
      outcome: "deny",
      risk: "high",
      status: "invalid",
    });
  });
});

describe("network approval reviewer", () => {
  it("reviews the exact retained destination and declares encrypted evidence limits", async () => {
    const { provider, model, complete } = makeProvider(
      '{"outcome":"allow","risk_level":"medium","user_authorization":"high","rationale":"Authorized package registry"}',
    );
    const reviewer = createNetworkApprovalReviewer({
      resolveContext: () => ({ provider, sessionModel: model }),
    });

    await expect(reviewer.review(reviewInput())).resolves.toEqual({
      outcome: "allow",
      risk: "medium",
      userAuthorization: "high",
      rationale: "Authorized package registry",
      model,
      status: "reviewed",
    });
    const call = complete.mock.calls[0]?.[0];
    expect(call?.systemPrompt).toContain(
      "request paths, payloads, credentials, response bodies, and redirect targets are unknown",
    );
    expect(call?.systemPrompt).toContain(
      "Redirects and later sockets are reviewed independently",
    );
    expect(JSON.stringify(call?.messages)).toContain("registry.npmjs.org");
    expect(JSON.stringify(call?.messages)).toContain("104.16.25.34");
    expect(JSON.stringify(call?.messages)).not.toContain("audit-1");
  });

  it("denies when no routable reviewer is available", async () => {
    const { provider, model } = makeProvider();
    const reviewer = createNetworkApprovalReviewer({
      resolveContext: () => ({
        provider: { ...provider, listRoutableModelIds: () => [] },
        sessionModel: model,
      }),
    });

    await expect(reviewer.review(reviewInput())).resolves.toMatchObject({
      outcome: "deny",
      status: "unavailable",
    });
  });

  it("denies a cancelled live request without calling the provider", async () => {
    const { provider, model, complete } = makeProvider();
    const controller = new AbortController();
    controller.abort();
    const reviewer = createNetworkApprovalReviewer({
      resolveContext: () => ({ provider, sessionModel: model }),
    });

    await expect(
      reviewer.review(reviewInput(controller.signal)),
    ).resolves.toMatchObject({
      outcome: "deny",
      status: "cancelled",
    });
    expect(complete).not.toHaveBeenCalled();
  });
});
