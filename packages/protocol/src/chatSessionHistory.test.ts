import { describe, expect, expectTypeOf, it } from "vitest";

import type { ChatSessionHistorySummary } from "./chatSessionHistory.js";

describe("chat session history protocol", () => {
  it("keeps the complete projected history row serializable", () => {
    const summary: ChatSessionHistorySummary = {
      id: "session-1",
      project: {
        projectId: "project-1",
        displayName: "AgentLink",
        availability: "available",
      },
      mode: "code",
      model: "gpt-5.6-sol",
      title: "Extract protocol DTOs",
      messageCount: 12,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      createdAt: 1,
      lastActiveAt: 2,
    };

    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it("pins the projected history fields and package-owned project dependency", () => {
    expectTypeOf<keyof ChatSessionHistorySummary>().toEqualTypeOf<
      | "id"
      | "project"
      | "mode"
      | "model"
      | "title"
      | "messageCount"
      | "totalInputTokens"
      | "totalOutputTokens"
      | "createdAt"
      | "lastActiveAt"
    >();
    expectTypeOf<ChatSessionHistorySummary["project"]>().toEqualTypeOf<
      import("./chatCatalog.js").ChatProjectInfo | undefined
    >();
  });
});
