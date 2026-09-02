import type {
  BrowserGatewayOwnerInteractionPayload,
  BrowserGatewayOwnerQuestionProgressPayload,
} from "./browserGatewayOwnerInteractionPayload.js";
import { expectTypeOf, it } from "vitest";

import type { ApprovalRequest } from "./approvalTransport.js";
import type { McpFormElicitationRequest } from "./mcpElicitation.js";
import type { McpUrlElicitationRequest } from "./mcpUrlElicitation.js";
import type { StructuredQuestionRequest } from "./structuredQuestion.js";

it("pins the browser gateway owner interaction detail contract", () => {
  expectTypeOf<BrowserGatewayOwnerInteractionPayload>().toEqualTypeOf<{
    approval: ApprovalRequest | null;
    question: StructuredQuestionRequest | null;
    questionProgress: BrowserGatewayOwnerQuestionProgressPayload | null;
    formElicitation: McpFormElicitationRequest | null;
    urlElicitation: McpUrlElicitationRequest | null;
  }>();

  expectTypeOf<
    BrowserGatewayOwnerQuestionProgressPayload["answers"]
  >().toEqualTypeOf<
    Record<string, string | readonly string[] | number | boolean | undefined>
  >();
});
