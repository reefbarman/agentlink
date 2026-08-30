import type {
  AgentErrorActions,
  AgentRuntimeErrorPresentation,
} from "./agentErrorPresentation.js";
import { expectTypeOf, it } from "vitest";

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
