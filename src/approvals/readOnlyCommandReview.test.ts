import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "../agent/providers/types.js";
import { createReadOnlyCommandReviewer } from "./readOnlyCommandReview.js";
import { describe, expect, it, vi } from "vitest";

const capabilities: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
};

function makeProvider(options: {
  response?: string;
  routable?: string[];
  complete?: (request: CompleteRequest) => Promise<CompleteResult>;
}) {
  const sessionModel = "session-model";
  const routable = options.routable ?? [sessionModel];
  const complete = vi.fn(
    options.complete ?? (async () => ({ text: options.response ?? "" })),
  );
  const provider: ModelProvider = {
    id: "test",
    displayName: "Test",
    condenseModel: "condense-model",
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

function reviewInput(command = "jq '.scripts' package.json") {
  return {
    sessionId: "session-1",
    command,
    cwd: "/workspace/project",
    workspaceRoots: ["/workspace/project"],
    task: "review the diff",
    staticDenialReason: "unrecognized command",
    userRuleDecision: "none" as const,
    rawInput: { command, timeout: 30_000 },
  };
}

describe("createReadOnlyCommandReviewer", () => {
  it("allows a command the guardian clears and forwards the evidence", async () => {
    const { provider, complete, sessionModel } = makeProvider({
      response: '{"outcome":"allow"}',
    });
    const reviewer = createReadOnlyCommandReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });

    const result = await reviewer.review(reviewInput());

    expect(result).toMatchObject({
      outcome: "allow",
      status: "reviewed",
      model: sessionModel,
    });
    const request = complete.mock.calls[0]?.[0] as CompleteRequest;
    expect(request.messages[0]?.content).toContain(
      "jq '.scripts' package.json",
    );
    expect(request.messages[0]?.content).toContain("unrecognized command");
    expect(request.messages[0]?.content).toContain("review the diff");
    expect(request.systemPrompt).toContain("read-only");
  });

  it("denies with the guardian rationale", async () => {
    const { provider, sessionModel } = makeProvider({
      response:
        '{"outcome":"deny","risk_level":"medium","user_authorization":"unknown","rationale":"redirects output to a file"}',
    });
    const reviewer = createReadOnlyCommandReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });

    const result = await reviewer.review(reviewInput("sort data.txt -o out"));

    expect(result).toMatchObject({
      outcome: "deny",
      status: "reviewed",
      rationale: "redirects output to a file",
    });
  });

  it("reports unavailable when no reviewer context resolves", async () => {
    const reviewer = createReadOnlyCommandReviewer({
      resolveContext: () => undefined,
    });

    const result = await reviewer.review(reviewInput());

    expect(result).toMatchObject({ outcome: "deny", status: "unavailable" });
  });

  it("treats an invalid response as a deny with invalid status", async () => {
    const { provider, sessionModel } = makeProvider({
      response: "sure, that looks fine",
    });
    const reviewer = createReadOnlyCommandReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });

    const result = await reviewer.review(reviewInput());

    expect(result).toMatchObject({ outcome: "deny", status: "invalid" });
  });

  it("serializes unserializable raw input defensively", async () => {
    const { provider, complete, sessionModel } = makeProvider({
      response: '{"outcome":"allow"}',
    });
    const reviewer = createReadOnlyCommandReviewer({
      resolveContext: () => ({ provider, sessionModel }),
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await reviewer.review({ ...reviewInput(), rawInput: cyclic });

    const request = complete.mock.calls[0]?.[0] as CompleteRequest;
    expect(request.messages[0]?.content).toContain("[unserializable]");
  });
});
