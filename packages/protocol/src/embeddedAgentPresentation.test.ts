import { describe, expect, it } from "vitest";
import {
  embeddedAgentErrorCategory,
  isEmbeddedAgentErrorCategory,
  isEmbeddedAgentToolPresentation,
} from "./embeddedAgentPresentation.js";

describe("embedded agent presentation contracts", () => {
  it("maps stable public codes without message parsing", () => {
    expect(embeddedAgentErrorCategory("tool_input_invalid")).toBe("validation");
    expect(embeddedAgentErrorCategory("tool_authorization_denied")).toBe(
      "authorization",
    );
    expect(embeddedAgentErrorCategory("session_revision_conflict")).toBe(
      "conflict",
    );
    expect(embeddedAgentErrorCategory("session_not_found")).toBe("not_found");
    expect(embeddedAgentErrorCategory("turn_execution_limit_reached")).toBe(
      "capacity",
    );
    expect(embeddedAgentErrorCategory("provider_unavailable")).toBe("provider");
    expect(embeddedAgentErrorCategory("future_unknown_code")).toBe("internal");
  });

  it("validates categories and bounded safe presentation metadata", () => {
    expect(isEmbeddedAgentErrorCategory("authorization")).toBe(true);
    expect(isEmbeddedAgentErrorCategory("mystery")).toBe(false);
    expect(
      isEmbeddedAgentToolPresentation({
        title: "Update account",
        confirmationLabel: "Update",
        denialMessage: "Update cancelled",
        destructive: true,
      }),
    ).toBe(true);
    expect(isEmbeddedAgentToolPresentation({ title: "" })).toBe(false);
    expect(isEmbeddedAgentToolPresentation({ title: "x".repeat(301) })).toBe(
      false,
    );
  });
});
