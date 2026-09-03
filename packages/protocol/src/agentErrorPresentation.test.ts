import type {
  AgentErrorActions,
  AgentRuntimeErrorPresentation,
} from "./agentErrorPresentation.js";
import { expect, expectTypeOf, it } from "vitest";

import { summarizeHtmlErrorText } from "./agentErrorPresentation.js";

it("summarizes HTML error pages for shared provider classification", () => {
  expect(summarizeHtmlErrorText("plain failure")).toBe("plain failure");
  expect(
    summarizeHtmlErrorText(
      "520 <html><body><h1>Unknown error</h1><ul><li>Ray ID: abc</li></ul></body></html>",
    ),
  ).toBe("520 Unknown error; Ray ID: abc");
});

it("keeps agent error presentation as a complete serializable DTO", () => {
  const presentation: AgentRuntimeErrorPresentation = {
    message: "Context window exceeded",
    retryable: true,
    code: "context_window_exceeded",
    actions: {
      signIn: false,
      signInAnotherAccount: true,
      condense: true,
    },
  };

  expectTypeOf(presentation.actions).toEqualTypeOf<
    AgentErrorActions | undefined
  >();
  expectTypeOf(presentation).toMatchTypeOf<{
    message: string;
    retryable: boolean;
    code?: string;
    actions?: AgentErrorActions;
  }>();
});
